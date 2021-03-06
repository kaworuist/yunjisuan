//
// Rayscale - Base raytracing classes
// (C) Ben Coleman 2018
//

import { Colour } from './colour';
import { vec4 } from 'gl-matrix';

export class Light {
  pos: vec4;            // Light position in world space
  brightness: number;
  kl: number;
  kq: number;
  colour: Colour;

  constructor(pos: vec4, brightness: number, radius: number) {
    this.pos = pos;
    this.brightness = brightness;
    this.colour = new Colour(1, 1, 1);

    this.kl = 2 / radius;
    this.kq = 1 / (radius * radius);
  }
}