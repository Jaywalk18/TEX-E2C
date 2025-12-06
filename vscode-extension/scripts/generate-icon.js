const sharp = require('sharp');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'images', 'icon.svg');
const pngPath = path.join(__dirname, '..', 'images', 'icon.png');

sharp(svgPath)
    .resize(128, 128)
    .png()
    .toFile(pngPath)
    .then(() => {
        console.log('✓ icon.png 生成成功！');
    })
    .catch(err => {
        console.error('生成失败:', err);
    });


