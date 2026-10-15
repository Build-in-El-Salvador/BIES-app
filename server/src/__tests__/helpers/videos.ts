/**
 * Videos for tests. The server makes videos smaller with ffmpeg
 * (services/mediaProcessing.ts): CI installs it, and FFMPEG_PATH and
 * FFPROBE_PATH can point elsewhere. Tests that upload a video are skipped
 * where it doesn't run.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export const HAS_FFMPEG = spawnSync(FFMPEG, ['-version']).status === 0 && spawnSync(FFPROBE, ['-version']).status === 0;

let made = 0;

/** A short made-up clip (MP4 with sound) from ffmpeg's test pattern; one thread, so other tests keep their pace. */
export function testClip(seconds = 1, size = '640x360'): Buffer {
    const file = path.join(os.tmpdir(), `bies-clip-${process.pid}-${++made}.mp4`);
    execFileSync(FFMPEG, [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', file,
    ]);
    try {
        return fs.readFileSync(file);
    } finally {
        fs.rmSync(file, { force: true });
    }
}
