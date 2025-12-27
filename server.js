const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("A-League backend running ✅");
});
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/api/value", (req, res) => {
  res.json({
    access: { used: 1, max: 19 },
    matches: [
      {
        league: "A-LEAGUE (MEN)",
        kickoffLocal: "Fri 21:00",
        home: "Sydney FC",
        away: "Melbourne Victory",
        markets: {
          "1x2": {
            probs: { H: 0.46, D: 0.26, A: 0.28 },
            odds: { H: 2.35, D: 3.60, A: 3.10 }
          },
          "ou25": { line: 2.5, probOver: 0.57, oddsOver: 2.05 },
          "ou35": { line: 3.5, probOver: 0.34, oddsOver: 3.30 }
        }
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
