const { Server } = require("socket.io");

function setupSocket(server) {
  const io = new Server(server);

  io.on("connection", (socket) => {
    console.log("[socket] 연결됨:", socket.id);
  });
}

module.exports = { setupSocket };
