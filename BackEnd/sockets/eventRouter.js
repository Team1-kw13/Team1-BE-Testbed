const { Server } = require("socket.io");

function setupSocket(server) {
  const io = new Server(server);

  io.on("connection", (socket) => {
    console.log("[socket] 연결됨:", socket.id);

    socket.on("openai:conversation", (data) => {
      const { type } = data;

      switch (type) {
        case "input_audio_buffer.commit":
          console.log("발화 시작");
          break;

        case "input_audio_buffer.append":
          console.log("오디오 버퍼 수신");
          break;

        case "input_audio_buffer.end":
          console.log("발화 끝");
          break;

        default:
          console.warn("알 수 없는 클라이언트 메시지:", type);
      }
    });

    socket.on("sonju:summarize", (data) => {
      console.log("요약 요청");
    });

    socket.on("disconnect", () => {
      console.log(`[socket] 연결 종료: ${socket.id}`);
    });
  });
}

module.exports = { setupSocket };
