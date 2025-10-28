// Keep bot alive
import http from 'http';
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
});
server.listen(3000);
console.log('Keep-alive server running on port 3000');