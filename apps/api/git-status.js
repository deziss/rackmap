const { execSync } = require('child_process');
try {
  const output = execSync('git status', { encoding: 'utf-8', cwd: '/home/anshukushwaha/95095/Backup/Desktop/learn/server-inventory' });
  console.log(output);
} catch (e) {
  console.error(e.stdout || e.message);
}
