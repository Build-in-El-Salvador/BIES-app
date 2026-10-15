// What the server takes in a video upload: its size before it's made
// smaller (server/src/controllers/upload.controller.ts and nginx) and its
// length (server/src/services/mediaProcessing.ts). Pure, so tests can import it.
export const MAX_VIDEO_MB = 50;
export const MAX_VIDEO_SECONDS = 120;
