require('dotenv').config();
const socketio = require('socket.io');
const readline = require('readline');
const express = require('express');
const morgan = require('morgan');
const canvas = require('canvas');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');

const logger = require('./utils/logger.js');
const config = require('./config.js');

const cache = new Map();
const frames = [];
let framesReady = false;
let status = 'idle';
let frameAt = 0;
let interval = 1000;
let connectedClients = 0;
let startedClients = 0;

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
const io = socketio(server, {
  transports: ['websocket']
});

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
    case 'start': {
      if (status === 'started') {
        logger.error('Clients already started!');
        break;
      }

      status = 'started';
      io.emit('start', interval);
      break;
    }

    case 'abort':
    case 'stop': {
      if (status === 'idle') {
        logger.error('Clients are not started!');
        break;
      }

      status = 'idle';
      frameAt = 0;
      io.emit('stop');
      break;
    }

    case 'setInterval': {
      if (isNaN(args[0])) {
        logger.error(`setInterval args[0] "${args[0]}" is not a number`);
        break;
      }
      if (status === 'started') logger.warn('Clients already started! Changing the interval time will only applied when restarting');
      if (parseInt(args[0]) < 500) logger.warn('Delay interval is less than 500ms! This could led to system overloading.');

      interval = parseInt(args[0]);
      break;
    }

    case 'reload': {
      if (args[0] && isNaN(args[0])) {
        logger.error(`reload args[0] "${args[0]}" is not a number`);
        break;
      }

      io.emit('reload', args[0]);
      break;
    }

    case 'sync': {
      if (status === 'started') return logger.error('Clients already started!');

      io.emit('sync');
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

app.get('/status', (_, res) => {
  res.json({
    status,
    framesReady,
    frameAt,
    framesCount: frames.length
  });
});

app.get('/frames', async (req, res) => {
  const frame = req.query.frame;
  const offsetX = req.query.offsetX;
  const offsetY = req.query.offsetY;

  if (!framesReady) await waitFramesReady();
  if ((frame <= 0 || frame > frames.length) && frame !== 'all') return res.status(400).json({ message: 'outOfBound' });

  const format = 'png';
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
      format
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
      format
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

  logger.debug(`Send frame reply to socket with ID "${socket.id}"`);

  const data = c.toDataURL('image/' + format);

  cache.set(frame + offsetX + offsetY, {
    width: c.width,
    height: c.height,
    data,
    format
  });
  setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

  return res.json('frame', {
    frame,
    offsetX,
    offsetY,
    width: c.width,
    height: c.height,
    data: c.toDataURL('image/jpeg'),
    format
  });
});

io.on('connection', (socket) => {
  connectedClients++;
  logger.info(`[${connectedClients}] Socket.io client connected with ID "${socket.id}"`);

  socket.on('started', () => {
    startedClients++;

    logger.info(`[${startedClients}] Socket with ID "${socket.id}" started playing (${(startedClients / connectedClients * 100).toFixed(2)}%)`);
  });

  socket.on('stopped', () => {
    startedClients--;

    logger.info(`[${startedClients}] Socket with ID "${socket.id}" stopped playing (${((connectedClients - startedClients) / connectedClients * 100).toFixed(2)}%)`);
  });

  socket.on('frameUpdate', (frame) => {
    frameAt = frame;
    if (frame === frames.length) {
      frameAt = 0;
      status = 'idle';
      io.emit('stop');

      return logger.info('Finished rendering!');
    }

    logger.info(`Rendering frames... [${frame} / ${frames.length} | ${(frame / frames.length * 100).toFixed(2)}%]`);
  });

  // FRAME REQUEST

  socket.on('frame', async ({ frame, offsetX, offsetY }) => {
    if (!framesReady) await waitFramesReady();
    if ((frame <= 0 || frame > frames.length) && frame !== 'all') return socket.emit('error', 'outOfBound', 'frames');

    const format = 'png';
    if (cache.has(frame + offsetX + offsetY)) {
      const { width, height, data, format } = cache.get(frame + offsetX + offsetY);
      return socket.emit('frame', {
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

      logger.debug(`Send all frames reply to socket with ID "${socket.id}"`);

      cache.set(frame + offsetX + offsetY, {
        width: c.width,
        height: c.height,
        data: arr,
        format
      });
      setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

      return socket.emit('frame', {
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
    if (!fr) {
      socket.emit('error', 'notFound', { type: 'frame', frame, offsetX, offsetY });
      return logger.debug(`Invalid frame (${frame}) requested by socket with ID "${socket.id}"`);
    }
    if (fr.width < config.segment.width * offsetX || fr.height < config.segment.height * offsetY) {
      socket.emit('error', 'outOfBound', 'frames');
      return logger.debug(`Socket with ID "${socket.id}" requested out-of-boundary area offset`);
    }

    if (offsetX <= 0 || offsetY <= 0) {
      logger.debug(`Socket with ID "${socket.id}" frame (${frame}) with offset of 0`);

      const c = canvas.createCanvas(fr.width, fr.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(fr, 0, 0, fr.width, fr.height);

      logger.debug(`Send entire frame reply to socket with ID "${socket.id}"`);

      const data = c.toDataURL('image/' + format);

      cache.set(frame + offsetX + offsetY, {
        width: c.width,
        height: c.height,
        data,
        format
      });
      setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

      return socket.emit('frame', {
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

    logger.debug(`Send frame reply to socket with ID "${socket.id}"`);

    const data = c.toDataURL('image/' + format);

    cache.set(frame + offsetX + offsetY, {
      width: c.width,
      height: c.height,
      data,
      format
    });
    setTimeout(() => cache.delete(frame + offsetX + offsetY), config.cacheLifetime);

    return socket.emit('frame', {
      frame,
      offsetX,
      offsetY,
      width: c.width,
      height: c.height,
      data: c.toDataURL('image/jpeg'),
      format
    });
  });

  socket.on('disconnect', () => {
    logger.info(`Socket.io client disconnected with ID "${socket.id}"`);

    connectedClients--;
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  logger.info(`Listening to port ${PORT}`);
});
