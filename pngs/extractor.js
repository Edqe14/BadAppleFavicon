const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

(async () => {
  const col = [];
  const files = fs.readdirSync('./').filter(f => f.split('.').pop() === 'png');

  let count = 0;
  for (let i = 1; i <= files.length; i++) {
    const f = `png${i.toString().padStart(3, 0)}.png`;

    count++;
    console.log(`Processing > ${f} ${(count / files.length * 100).toFixed(2)}%`);

    const a = [];

    const image = await loadImage(`./${f}`);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (let y = 0; y < canvas.height; y++) {
      const ya = [];

      for (let x = 0; x < canvas.width; x++) {
        const canvasColor = ctx.getImageData(x, y, 1, 1).data;
        const color = './assets/' + guess(...canvasColor) + '.jpg';

        ya.push(color);
      }
      a.push(ya);
    }

    col.push(a);
  }

  fs.writeFileSync('./export.js', 'window.frames = ' + JSON.stringify(col));
})();

function guess (r, g, b) {
  const calc = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (calc < 85) return 'black';
  if (calc > 85 && calc < 170) return 'gray';
  return 'white';
}
