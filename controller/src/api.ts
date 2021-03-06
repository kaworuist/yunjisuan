//
// API controller for all routes and core app logic
// ------------------------------------------------
// Ben C, May 2018
//

import { Request, Response } from 'express';
import request from 'request-promise-native';
import randstr from 'randomstring';
import * as PNG from 'pngjs';
import * as yaml from 'js-yaml';
import fs from 'fs';
import { Job } from './lib/job';
import { JobInput } from './lib/job-input';
import { Task } from './lib/task';
import { Tracer } from './lib/tracer';

// ====================================================================================================
// Class acts as a holder for all API route handlers and some private functions they need
// ====================================================================================================
export class API {

  // Tracers is a dictionary map of strings -> Tracer
  // The key is the URL of that tracer, which has the bonus of being unique
  private tracers: { [id: string]: Tracer };
  private job: Job;
  private jobOutDir: string;
  private inputJobYaml: string;
  private checkInterval: number;

  constructor(outDir: string, checkInterval: number) {
    // Tracers starts as empty dict  
    this.tracers = {};
    this.jobOutDir = outDir;
    this.checkInterval = checkInterval;
  }

  // ====================================================================================
  // API: Register a new tracer/worker
  // ====================================================================================
  public addTracer = (req: Request, res: Response) => {
    let tracer = new Tracer(req.body.endPoint, req.body.id);

    this.tracers[tracer.endPoint] = tracer;
    console.log(`### Tracer registered: ${tracer.endPoint}`);

    res.contentType('application.json');
    res.status(200).send({ msg: "Tracer registered" });
  
    console.log(`### Tracers online: ${Object.keys(this.tracers).length}`);
  }
  
  // ====================================================================================
  // API: Start a new job, POST data is inital job data
  // ====================================================================================
  public startJob = (req: Request, res: Response) => {
    res.type('application/json');
    console.log(`### New job request received`);

    // Check active job  
    //if(res.app.get('env').toLowerCase() == "production") {
      if(this.job && this.job.status == "RUNNING") {
        console.log(`### Job rejected. There is currently an active job '${this.job.name}' with ${this.job.totalTasks} of ${this.job.tasksRemaining} tasks remaining`);
        res.status(400).send({msg: "There is currently an active job"}); return;
      }
    //}

    // Check if we have any tracers
    if(Object.keys(this.tracers).length <= 0) {
      console.log(`### Job rejected. No tracers online, unable to start job`);
      res.status(400).send({msg: "No tracers online"}); return;
    }

    // Convert YAML to JSON
    let jobInput: any = null;
    try {
      jobInput = yaml.safeLoad(req.body.toString());
      this.inputJobYaml = req.body.toString();
    } catch(err) {
      console.error(`### ERROR! YAML conversion failed ${err.message}`);
      res.status(400).send({msg: `YAML conversion failed ${err.message}`}); return;
    }

    // Create complete job object and kick everything off
    try {
      this.createJob(jobInput)
    } catch(e) {
      res.status(400).send({msg: `Job invalid ${e}`});
      return;
    }
    res.status(200).send({msg: "Job started", id: this.job.id});
  }

  // ====================================================================================
  // API: Task results send back from tracer
  // ====================================================================================
  public taskComplete = (req: Request, res: Response) => {
    // Ignore results if job not running (i.e CANCELLED or FAILED)
    if(this.job.status != "RUNNING") { 
      console.log(`### Task results '${req.params.id}' discared as job is ${this.job.status}`);
      res.status(200).send({ msg: "OK, slice buffer discarded" });
      return;
    }

    let taskId = req.params.id;
    let taskIndex = req.headers['x-task-index'];
    let taskTracer: string = req.headers['x-tracer'].toString();
    this.job.stats.raysCreated += parseInt(req.headers['x-stats-rayscreated'].toString());
    this.job.stats.raysCast += parseInt(req.headers['x-stats-rayscast'].toString());
    this.job.stats.shadowRays += parseInt(req.headers['x-stats-shadowrays'].toString());
    this.job.stats.objectTests += parseInt(req.headers['x-stats-objtests'].toString());
    this.job.stats.meshFaceTests += parseInt(req.headers['x-stats-meshtests'].toString());

    // If we get anything other than binary data, that's a failure
    if(req.headers['content-type'] != 'application/octet-stream') {
      console.error(`### ERROR! Task ${taskId} has failed, job will not complete`);
      this.job.status = "FAILED";
      this.job.reason = `Ray tracing failed, task ${taskIndex} had an error`;
      res.status(200).send({msg: "OK, you failed"});
      return;
    }
    console.log(`### Image buffer received from ${taskTracer} for task: ${taskIndex}`);

    // Raw buffer (binary) body
    let buff = req.body;
    // Locate the task by taskId, we could also use taskIndex
    let task = this.job.tasks.find(t => t.id == taskId);

    this.job.tasksComplete++;
    console.log(`### Tasks completed: ${this.job.tasksComplete} of ${this.job.totalTasks}`);

    for (var x = 0; x < this.job.width; x++) {
      let yBuff = 0;

      for (var y = task.sliceStart; y < (task.sliceStart+task.sliceHeight); y++) {
        let pngIdx = (this.job.width * y + x) << 2;
        let buffIndx = ((this.job.width * yBuff + x) * 3);

        this.job.png.data[pngIdx + 0] = buff[buffIndx + 0];
        this.job.png.data[pngIdx + 1] = buff[buffIndx + 1];
        this.job.png.data[pngIdx + 2] = buff[buffIndx + 2];
        this.job.png.data[pngIdx + 3] = 255
        yBuff++;
      }
    }

    if(this.job.tasksRemaining <= 0) {
      // We're DONE!
      this.completeJob();
    } else {
      if(this.job.tasksInQueue > 0) {
        let tracer: Tracer = this.tracers[taskTracer];
        this.assignTaskToTracer(tracer);
      }
    }
    
    res.status(200).send({ msg: "OK, slice buffer stored" });
  }
  
  // ====================================================================================
  // Regular tracer health check, remove tracers that are not contactable 
  // ====================================================================================
  public tracerHealthCheck = () => {
    // Skip checks when rendering a job
    // With very long/intense jobs the health checks would fail, due to API stops responding during render
    if(this.job && this.job.status == "RUNNING") {
      return;
    }

    for(let tid in this.tracers) {
      let endPoint = this.tracers[tid].endPoint;
  
      // Call health ping API on tracer, expect 200 and nothing more
      request({ uri: `${endPoint}/ping` }) //, timeout: this.checkInterval - 1 })
      .then(resp => { /* Do nothing */ })
      .catch(err => {
        console.log(`### Health check failed for ${endPoint} - Unregistering tracer`);
        delete this.tracers[tid];

        // If we had a job in progress we're probably screwed, so fail the job
        // if(this.job && this.job.status == "RUNNING") {
        //   console.log(`### ERROR! One or more tracers went offline while job was running`);
        //   this.job.status = "FAILED";
        //   this.job.reason = `One or more tracers went offline while job was running`;
        // }

        console.log(`### Tracers online: ${Object.keys(this.tracers).length}`);
      });
    }
  }

  // ====================================================================================
  // Create a new render job, with sub tasks fired off to tracers
  // ====================================================================================
  private createJob(jobInput: JobInput) {
    // Job object holds a lot of state
    this.job = new Job();

    // Basic checks
    if(!jobInput.name) throw('Job must have a name');
    if(!jobInput.width) throw('Job must have a width');
    if(!jobInput.height) throw('Job must have a height');
    if(!jobInput.scene) throw('Job must have a scene');

    // Basic job info supplied to us
    this.job.name = jobInput.name;
    this.job.width = jobInput.width;
    this.job.height = jobInput.height;

    // Add extra properties and objects we need
    this.job.startDate = new Date();
    this.job.startTime = new Date().getTime();
    this.job.id = randstr.generate(5);
    this.job.status = "RUNNING"; 
    this.job.reason = ""; 
    //this.job.tasksComplete = 0;
    this.job.png = new PNG.PNG({ width: this.job.width, height: this.job.height });
    this.job.stats = {
      raysCreated: 0,
      raysCast: 0,
      shadowRays: 0,
      objectTests: 0,
      meshFaceTests: 0
    };
    this.job.rawScene = jobInput.scene;
  
    // Create tasks
    // Logic to slice image into sub-regions is here
    this.job.tasks = [];
    this.job.taskQueue = [];
    this.job.tasksComplete = 0;
    let requestedTaskCount = 0;
    if(!jobInput.tasks) {
      requestedTaskCount = Object.keys(this.tracers).length;
      console.log(`### WARNING! Task count not supplied, using default: ${requestedTaskCount}`);
    } else {
      requestedTaskCount = jobInput.tasks;
      if(requestedTaskCount > jobInput.height) {
        throw 'Error! Can not request more tasks than image height!';
      }
    }
    // Using ceil here removes rounding bug where image height not divisible by number tasks 
    let sliceHeight = Math.ceil(this.job.height / requestedTaskCount);
    for(let taskIndex = 0; taskIndex < requestedTaskCount; taskIndex++) {
      let task = new Task();
      task.id = randstr.generate(5);
      task.jobId = this.job.id;
      task.imageWidth = this.job.width;
      task.imageHeight = this.job.height;
      task.index = taskIndex;
      task.sliceStart = taskIndex * sliceHeight;
      task.sliceHeight = sliceHeight;
      task.maxDepth = jobInput.maxDepth || 4;
      task.antiAlias = jobInput.antiAlias || false;

      this.job.tasks.push(task); 
      this.job.taskQueue.push(task.id);
    }

    console.log(`### New job created: '${this.job.name}' with ${this.job.totalTasks} tasks`);

    // First pass, send one task out to each tracer online
    for(let tid in this.tracers) {
      let tracer = this.tracers[tid];
      this.assignTaskToTracer(tracer);
    }
  }

  // ====================================================================================================
  // Assign a random unassigned task to a remote tracer via the REST API
  // Payload is simple JSON object with two members, task and scene
  // ====================================================================================================
  private assignTaskToTracer(tracer: Tracer) {
    // Get random task not yet assigned
    if(this.job.tasksRemaining <= 0) return;

    let unassignedTaskIndex = Math.floor(Math.random() * this.job.taskQueue.length)
    let taskId = this.job.taskQueue[unassignedTaskIndex];
    // Remember to remove from array!
    this.job.taskQueue.splice(unassignedTaskIndex, 1) 
    let task = this.job.tasks.find(t => t.id == taskId);

    // Send to tracer
    console.log(`### Sending task ${task.id}:${task.index} to ${tracer.endPoint}`);
    request.post({
      uri: `${tracer.endPoint}/tasks`,
      body: JSON.stringify({ task: task, scene: this.job.rawScene }),
      headers: { 'content-type': 'application/json' }
    })
    .then(() => {

    })
    .catch(err => {
      console.error(`### ERROR! Unable to send task to tracer ${err}`);
      this.job.status = "FAILED";
      this.job.reason = err.message;
    })
  }

  // ====================================================================================
  // Job completion, output image, gather stats etc
  // ====================================================================================
  private completeJob(): void {
    let outDir = `${this.jobOutDir}/${this.job.name}`;
    if (!fs.existsSync(outDir)){
      fs.mkdirSync(outDir);
    }

    this.job.endDate = new Date();
    this.job.durationTime = (new Date().getTime() - this.job.startTime) / 1000;

    if(this.job.status == 'CANCELLED') {
      fs.writeFileSync(`${outDir}/result.json`, JSON.stringify({
        status: this.job.status,
        reason: this.job.reason,
        start: this.job.startDate,
        end: this.job.endDate,
        durationTime: this.job.durationTime
      }, null, 2));
      fs.writeFileSync(`${outDir}/job.yaml`, this.inputJobYaml);  
      return;      
    }
    
    if(this.job.status != 'RUNNING') {
      return;
    }

    // Write out result PNG file
    this.job.png.pack()
    .pipe(fs.createWriteStream(`${outDir}/${this.job.name}.png`))
    .on('finish', () => {
      // Output debug info and stats JSON
      this.job.status = "COMPLETE";
      this.job.reason = `Render completed in ${this.job.durationTime} seconds`;
      let results: any = {
        status: this.job.status,
        reason: this.job.reason,
        start: this.job.startDate,
        end: this.job.endDate,
        durationTime: this.job.durationTime,
        imageWidth: this.job.width,
        imageHeight: this.job.height,
        pixels: this.job.width * this.job.height,
        tasks: this.job.totalTasks,
        tracersUsed: Object.keys(this.tracers).length,
        RPP: this.job.stats.raysCast / (this.job.width * this.job.height),
        stats: this.job.stats
      };
      console.log('### Results details: ', results);
      console.log(`### Render complete, ${outDir}/${this.job.name}.png saved`);
      console.log(`### Job completed in ${this.job.durationTime} seconds`);
  
      // Supplementary result files
      fs.writeFileSync(`${outDir}/result.json`, JSON.stringify(results, null, 2));
      fs.writeFileSync(`${outDir}/job.yaml`, this.inputJobYaml);      
    });
  }

  // ====================================================================================
  // API: Provide current status
  // ====================================================================================
  public getStatus = (req: Request, res: Response) => {
    if(this.job) {
      res.status(200).send({
        job: {
          name: this.job.name,
          status: this.job.status,
          reason: this.job.reason,
          started: this.job.startDate,
          tasksComplete: this.job.tasksComplete,
          taskCount: this.job.totalTasks
        }
      })
    } else {
      res.status(200).send({ msg: "Controller has no job, maybe nothing has run yet" });
    }
  }
  
  // ====================================================================================
  // List out the jobs directory, used by the UI
  // ====================================================================================
  public listJobs = (req: Request, res: Response) => {
    let jobData: any = {jobs:[]};
    fs.readdirSync(this.jobOutDir).forEach(file => {
      jobData.jobs.push(file);
    })

    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(jobData)
  }

  // ====================================================================================
  // List online tracers, used by the UI
  // ====================================================================================
  public listTracers = (req: Request, res: Response) => {
    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(this.tracers)
  } 

  // ====================================================================================
  // Cancel job!
  // ====================================================================================
  public cancelJob = (req: Request, res: Response) => {
    if(this.job && this.job.status == "RUNNING") {
      this.job.status = "CANCELLED";
      this.job.reason = "Cancelled by user at "+(new Date().toDateString());
      this.completeJob();
      res.status(200).send({ msg: "Job cancelled" })
    } else {
      res.status(400).send({ msg: "No running job to cancel" })
    }
  }  
}