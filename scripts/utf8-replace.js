const fs = require('fs');

const [, , file, searchValue, replaceValue] = process.argv;

if (!file || searchValue === undefined || replaceValue === undefined) {
  console.error('Usage: node scripts/utf8-replace.js <file> <search> <replace>');
  process.exit(1);
}

const original = fs.readFileSync(file, 'utf8');
if (!original.includes(searchValue)) {
  console.error(`Search text not found in ${file}: ${searchValue}`);
  process.exit(1);
}

const updated = original.split(searchValue).join(replaceValue);
fs.writeFileSync(file, updated, 'utf8');
console.log(`Updated ${file}`);
