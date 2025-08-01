const express = require("express");

const app = express();

app.get("", (req, res) => {
  res.send("테스트용 손주 백엔드입니다.");
});

module.exports = app;
