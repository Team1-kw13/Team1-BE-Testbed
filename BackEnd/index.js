const app = require("./app");
const http = require("http");
const { setupSocket } = require("./sockets/eventRouter");

require("dotenv").config();

const server = http.createServer(app);
setupSocket(server);

server.listen(3000, () => {
  console.log("포트 3000에서 서버 실행중...");
});
