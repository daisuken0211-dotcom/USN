precision mediump float;
uniform sampler2D u_texture;
uniform float u_time;
uniform float u_strength; // 0..1
uniform vec2 u_resolution;
uniform float u_centerX; // 0..1 (center vertical line)
uniform int u_objCount;
uniform vec4 u_objs[8]; // x,y,w,h in 0..1 coords
varying vec2 v_texcoord;

// simple pseudo-random
float rand(vec2 co){
  return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}

void main(){
  vec2 uv = v_texcoord;
  float center = u_centerX;
  vec4 color = texture2D(u_texture, uv);
  // Scene-level left-side effect
  if(uv.x < center){
    // falloff based on distance from center (0 at center -> 1 at left edge)
    float t = smoothstep(center, 0.0, uv.x);
    // distortion offset horizontal
    float wave = sin((uv.y*20.0 + u_time*2.0) ) * 0.01 * u_strength;
    float noise = (rand(uv + u_time) - 0.5) * 0.02 * u_strength;
    vec2 displaced = uv + vec2(wave + noise * t, 0.0);
    // small blur-like mix with neighbors
    vec4 c1 = texture2D(u_texture, displaced + vec2(0.002,0.0));
    vec4 c2 = texture2D(u_texture, displaced + vec2(-0.002,0.0));
    color = mix(color, (c1 + c2) * 0.5, 0.6 * t * u_strength);
    // occasional strong blackout (random flicker)
    float r = rand(vec2(u_time*10.0, uv.y*100.0));
    if(r < 0.02 * u_strength){
      color.rgb *= 0.1; // darken strongly
    }
  }

  // Object-based left-half effect
  for(int i=0;i<8;i++){
    if(i >= u_objCount) break;
    vec4 ob = u_objs[i];
    // ob: x,y,w,h in 0..1
    // transform uv to object local coords
    if(uv.x >= ob.x && uv.x <= ob.x + ob.z && uv.y >= ob.y && uv.y <= ob.y + ob.w){
      // check if this is left half of object (relative to object center)
      float objCenterX = ob.x + ob.z * 0.5;
      if(uv.x < objCenterX){
        // random per-object flicker probability
        float p = 0.4 * u_strength; // probability to apply
        float rr = rand(vec2(float(i)*12.34 + u_time, uv.y*100.0));
        if(rr < p){
          // strong distortion for object-left
          float dx = sin((uv.y*30.0 + float(i)*1.3 + u_time*4.0)) * 0.03 * u_strength;
          vec4 c = texture2D(u_texture, uv + vec2(dx,0.0));
          // mix heavily, add darken/blur feel
          color = mix(color, c, 0.85);
          color.rgb *= 0.7; // slight dim
        }
      }
    }
  }

  gl_FragColor = color;
}
