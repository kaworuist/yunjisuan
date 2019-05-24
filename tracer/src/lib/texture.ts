//
// Rayscale - Base raytracing classes
// (C) Ben Coleman 2018
//

import { Colour } from './colour';

// ====================================================================================================
// Base texture class (abstract)
// ====================================================================================================
export abstract class Texture {
  solid: boolean = false;
  scaleU: number = 1;     // Scaling factor of u in texture space
  scaleV: number = 1;     // Scaling factor of v in texture space

  // ====================================================================================================
  // Used for UV based 2D textures (TextureBasic, TextureCheck2D and TextureImage)
  // ====================================================================================================
  getColourAt(u: number, v: number): Colour {
    throw new Error('Not implemented')
  };

  // ====================================================================================================
  // 
  // ====================================================================================================
  getColourAtSolid(x: number, y: number, z: number): Colour {
    throw new Error('Not implemented');
  }
}