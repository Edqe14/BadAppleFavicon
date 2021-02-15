module.exports = {
  filename: './files/help.mp4',
  size: {
    width: 320,
    height: 192
  },
  segment: {
    width: 16,
    height: 16
  },
  fps: 20,
  out: './files/wtf.mp4',
  framesDir: './files/wtf_frames',
  skipProcessing: false,
  enableCache: true,
  cacheLifetime: 10 * 60 * 1000
};
