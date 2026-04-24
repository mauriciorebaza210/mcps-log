const fs = require('fs');

const content = fs.readFileSync('js/features/home.js', 'utf8');

let newContent = content;

newContent = newContent.replace(/\/\* Inject advanced CSS styles[\s\S]*?document\.head\.appendChild\(style\);\s*\}\n/, '');

fs.writeFileSync('js/features/home.js', newContent);
