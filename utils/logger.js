const winston = require('winston');
const path = require('path');

const logger = module.exports = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '..', 'logs', `${Date.now()}.log`),
      handleExceptions: true,
      maxsize: 5242880
    })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
    level: 'debug',
    handleExceptions: true
  }));
}
