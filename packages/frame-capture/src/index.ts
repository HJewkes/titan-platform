export { TITAN_MOTION_GLOBAL, type TitanMotionApi } from './protocol.js'
export { VIRTUAL_TIME_SCRIPT, type VirtualTimeApi } from './virtual-time.js'
export {
  captureFrame,
  launch,
  openCapturePage,
  settleFonts,
  type CapturePage,
  type FontState,
  type PageOptions,
  type Viewport,
} from './capture.js'
export { captureFrames, type FramesOptions, type FramesResult } from './frames.js'
export { mixAudio, startEncoder, type Encoder, type MixSegment } from './encode.js'
