require('dotenv').config();
const readline = require('readline');
const express = require('express');
const morgan = require('morgan');
const canvas = require('canvas');
const cors = require('cors');
const http = require('http');
const path = require('path');
const open = require('open');
const fs = require('fs');

const logger = require('./utils/logger.js');
const config = require('./config.js');

if (!config.root?.length || !config.filename?.length || !config.out?.length || !config.framesDir?.length) {
  logger.error('Invalid required paths');
  process.exit(1);
}

if (!fs.existsSync(config.root)) fs.mkdirSync(config.root);

const cache = new Map(fs.existsSync(path.join(__dirname, config.root, 'cache.json')) ? require(path.join(__dirname, config.root, 'cache.json')) : []);
cache.forEach((val, key) => {
  if (typeof val === 'object' && val?.expire && !isNaN(val?.expire) && parseInt(val.expire) > Date.now()) return;
  return cache.delete(key);
});

const frames = [];
const format = 'png';
let framesReady = false;
let interval = 1000;

const waitFramesReady = () => new Promise(resolve => {
  const check = () => {
    if (framesReady) return resolve();
    setTimeout(check, 500);
  };
  check();
});

const loadFrames = () => {
  Promise.all([
    new Promise(resolve => {
      (async () => {
        for (let i = 1; i <= fs.readdirSync(config.framesDir).filter(f => f.split('.').pop() === 'png').length; i++) {
          const img = await canvas.loadImage(path.join(config.framesDir, `frame-${i.toString().padStart(3, 0)}.png`));
          frames.push(img);
        }

        framesReady = true;
        logger.info('Frames loaded');
        resolve();
      })();
    })
  ]);
};

if (!config.skipProcessing) {
  const ffmpeg = require('fluent-ffmpeg');
  if (!fs.existsSync(config.filename)) logger.error('Missing original video file on the specified path!');
  else {
    if (config.size.width % config.segment.width !== 0) logger.warn(`Rescale width cannot be divided by ${config.segment.width}`);
    if (config.size.height % config.segment.height !== 0) logger.warn(`Rescale height cannot be divided by ${config.segment.height}`);

    ffmpeg(config.filename)
      .noAudio()
      .complexFilter(`scale=${config.size.width}:${config.size.height}`)
      .format('mp4')
      .on('error', (e) => logger.error(`Error on processing video "${e.message}"`))
      .on('end', () => {
        logger.info('Finished scaling the video');

        ffmpeg(config.out)
          .FPS(config.fps)
          .on('error', (e) => logger.error(`Error on processing video "${e.message}"`))
          .on('end', async () => {
            logger.info('Finished exporting the frames');

            loadFrames();
          })
          .save(path.join(config.framesDir, 'frame-%03d.png'));
      })
      .save(config.out);
  }
} else {
  logger.info('Skipped video processing');

  loadFrames();
}

const app = express();
const server = http.createServer(app);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  removeHistoryDuplicates: true,
  terminal: false,
  prompt: '» '
});
rl.prompt();
rl.on('line', (l) => {
  const args = l.split(' ');
  const cmd = args.shift();

  switch (cmd) {
    case 'setInterval': {
      if (isNaN(args[0])) {
        logger.error(`setInterval args[0] "${args[0]}" is not a number`);
        break;
      }

      if (parseInt(args[0]) < 500) logger.warn('Delay interval is less than 500ms! This could led to system overloading.');

      interval = parseInt(args[0]);
      break;
    }

    default: {
      console.info(`Unknown command "${cmd}"`);
      break;
    }
  }

  rl.prompt();
});

app.use(cors());
app.use(morgan('tiny', {
  stream: {
    write: (msg) => logger.info(msg)
  }
}));
app.use((_, res, next) => {
  res.header({
    'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/scripts', express.static(path.join(__dirname, 'node_modules')));
app.get('/meta', (_, res) => {
  res.json({
    framesReady,
    framesCount: frames.length,
    interval,
    format
  });
});

app.get('/frames', async (req, res) => {
  const frame = req.query.frame;
  const offsetX = req.query.offsetX;
  const offsetY = req.query.offsetY;

  if (!framesReady) await waitFramesReady();
  if ((frame <= 0 || frame > frames.length) && frame !== 'all') return res.status(400).json({ message: 'outOfBound' });

  if (cache.has(frame + offsetX + offsetY)) {
    const { width, height, data, format } = cache.get(frame + offsetX + offsetY);
    return res.json({
      frame,
      offsetX,
      offsetY,
      width,
      height,
      data,
      format
    });
  }

  if (frame === 'all') {
    const arr = [];

    const c = canvas.createCanvas(config.segment.width, config.segment.height);
    const ctx = c.getContext('2d');
    for (const fr of frames) {
      ctx.drawImage(fr, (config.segment.width * (offsetX - 1)), (config.segment.height * (offsetY - 1)), 16, 16, 0, 0, config.segment.width, config.segment.width);
      arr.push(c.toDataURL('image/' + format));
    }

    cache.set(frame + offsetX + offsetY, {
      width: c.width,
      height: c.height,
      data: arr,
      format,
      expire: Date.now() + config.cacheLifetime
    });
    setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

    return res.json({
      frame,
      offsetX,
      offsetY,
      width: c.width,
      height: c.height,
      data: arr,
      format
    });
  }

  const fr = frames[frame - 1];
  if (!fr) return res.status(400).json({ message: 'invalid frame' });
  if (fr.width < config.segment.width * offsetX || fr.height < config.segment.height * offsetY) return res.status(400).json({ message: 'outOfBound' });

  if (offsetX <= 0 || offsetY <= 0) {
    const c = canvas.createCanvas(fr.width, fr.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(fr, 0, 0, fr.width, fr.height);

    const data = c.toDataURL('image/' + format);

    cache.set(frame + offsetX + offsetY, {
      width: c.width,
      height: c.height,
      data,
      format,
      expire: Date.now() + config.cacheLifetime
    });
    setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

    return res.json({
      frame,
      offsetX,
      offsetY,
      width: fr.width,
      height: fr.height,
      data,
      format
    });
  }

  const c = canvas.createCanvas(config.segment.width, config.segment.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(fr, (config.segment.width * (offsetX - 1)), (config.segment.height * (offsetY - 1)), 16, 16, 0, 0, config.segment.width, config.segment.width);

  const data = c.toDataURL('image/' + format);

  cache.set(frame + offsetX + offsetY, {
    width: c.width,
    height: c.height,
    data,
    format,
    expire: Date.now() + config.cacheLifetime
  });
  setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

  return res.json('frame', {
    frame,
    offsetX,
    offsetY,
    width: c.width,
    height: c.height,
    data: c.toDataURL('image/' + format),
    format
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, async () => {
  logger.info(`Listening to port ${PORT}`);
  if (config.automaticallyOpenFirefox) await open(`localhost:${PORT}/opener.html?t=${config.size.width / config.segment.width}`, { app: { name: open.apps.firefox } });
});

process.on('exit', () => {
  if (config.saveCacheToFile) fs.writeFileSync(path.join(__dirname, config.root, 'cache.json'), JSON.stringify([...cache]));
  process.exit(1);
});
process.on('SIGINT', () => process.emit('exit', 1));
