import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health check ────────────────────────────────
app.get("/", (req, res) => {
  res.send("RankSathi Backend is Running ✅");
});

// ─── Main endpoint ────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { url, htmlContent } = req.body;

  if (!url && !htmlContent) {
    return res.status(400).json({
      success: false,
      error: "No URL or HTML content provided"
    });
  }

  try {
    let html = htmlContent;

    // If no HTML content provided, fetch it from the URL
    if (!html && url) {
      console.log(`Attempting Stealth Fetch for URL: ${url}`);
      try {
        const response = await axios.get(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Cache-Control": "max-age=0",
          },
          timeout: 15000,
          maxRedirects: 5
        });
        html = response.data;
      } catch (fetchErr: any) {
        console.error(`Fetch Error: ${fetchErr.message}`);
        // If it still fails, it's a hard IP block
        return res.status(502).json({
          success: false,
          error: "IP Blocked by TCS",
          message: "TCS has blocked Render's server. To fix this like RankMitra, you need a Proxy or use the 'Upload HTML' button.",
          details: fetchErr.message
        });
      }
    }

    if (!html) {
      throw new Error("Failed to obtain HTML content");
    }

    // STEP 2: Load into cheerio
    const $ = cheerio.load(html);

    // STEP 3: Extract candidate info
    function getText(selectors: string[]) {
      for (const sel of selectors) {
        const text = $(sel).first().text().trim();
        if (text && text.length > 0) return text;
      }
      return "N/A";
    }

    const candidateInfo = {
      name:  getText([".cand-info td:nth-child(2)",
                      ".candidate-name", "[class*='cand']",
                      "td:contains('Name') + td"]),
      roll:  getText([".roll-no", "[class*='roll']",
                      "td:contains('Roll') + td"]),
      date:  getText(["td:contains('Date') + td",
                      "[class*='date']", ".exam-date"]),
      time:  getText(["td:contains('Time') + td",
                      "[class*='time']", ".exam-time"]),
      venue: getText(["td:contains('Venue') + td",
                      "td:contains('Centre') + td",
                      "[class*='venue']"]),
      exam:  getText(["td:contains('Post') + td",
                      "td:contains('Exam') + td",
                      "td:contains('Subject') + td"])
    };

    // STEP 4: Parse every question
    let questions: any[] = [];

    // Method A: Digialm standard class structure
    $(".question-pnl").each((i, el) => {
      const correctAns =
        $(el).find(".rightAns").text().trim() ||
        $(el).find("[class*='right']").text().trim();
      const userAns =
        $(el).find(".userAns").text().trim() ||
        $(el).find("[class*='user']").text().trim();

      questions.push({
        qNo: i + 1,
        correct: normalizeOption(correctAns),
        candidate: normalizeOption(userAns)
      });
    });

    // Method B: Table row fallback
    if (questions.length === 0) {
      $("table tr").each((i, row) => {
        const cols = $(row).find("td");
        if (cols.length >= 4) {
          const correctAns = $(cols.eq(2)).text().trim();
          const userAns    = $(cols.eq(3)).text().trim();
          if (correctAns && correctAns !== "Correct Option") {
            questions.push({
              qNo: questions.length + 1,
              correct: normalizeOption(correctAns),
              candidate: normalizeOption(userAns)
            });
          }
        }
      });
    }

    // STEP 5: Score calculation
    let correct = 0, wrong = 0, skipped = 0;

    questions.forEach(q => {
      if (!q.candidate || q.candidate === "") {
        skipped++;
      } else if (q.candidate === q.correct) {
        correct++;
      } else {
        wrong++;
      }
    });

    const attempted  = correct + wrong;
    const score      = parseFloat((correct - (wrong / 3)).toFixed(2));
    const accuracy   = attempted > 0
      ? parseFloat(((correct / attempted) * 100).toFixed(2)) : 0;
    const percentile = parseFloat(((score / 75) * 100).toFixed(2));
    const rank       = getRank(score);

    // STEP 6: Subject-wise breakdown
    const subjects = [
      { name: "Mathematics",                         from: 1,  to: 20 },
      { name: "Mental Ability (Reasoning)",           from: 21, to: 45 },
      { name: "General Science",                     from: 46, to: 65 },
      { name: "General Awareness & Current Affairs", from: 66, to: 75 }
    ];

    const subjectResults = subjects.map(sub => {
      const subQs = questions.filter(
        q => q.qNo >= sub.from && q.qNo <= sub.to
      );
      const r = subQs.filter(q => q.candidate === q.correct).length;
      const w = subQs.filter(
        q => q.candidate && q.candidate !== "" && q.candidate !== q.correct
      ).length;
      const na      = subQs.length - r - w;
      const marks   = parseFloat((r - w / 3).toFixed(2));
      return {
        subject:  sub.name,
        total:    subQs.length,
        attempt:  r + w,
        na,
        r,
        w,
        marks
      };
    });

    // STEP 7: Qualifying status
    const qualifying = {
      UR:  score >= 30,
      EWS: score >= 30,
      OBC: score >= 22.5,
      SC:  score >= 22.5,
      ST:  score >= 18.75
    };

    // STEP 8: Return full result
    return res.json({
      success: true,
      candidateInfo,
      result: {
        correct,
        wrong,
        skipped,
        attempted,
        score,
        accuracy,
        percentile,
        rank,
        totalQuestions: questions.length
      },
      subjectResults,
      qualifying
    });

  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: "Could not fetch or parse the URL",
      message: err.message,
      fallback: "Please upload the HTML file directly"
    });
  }
});

// ─── Helpers ─────────────────────────────────────

function normalizeOption(val: string) {
  if (!val) return "";
  val = val.trim().toUpperCase();
  if (["--", "NA", "N/A", "NOT ANSWERED", ""].includes(val)) return "";
  if (val === "1") return "A";
  if (val === "2") return "B";
  if (val === "3") return "C";
  if (val === "4") return "D";
  return val;
}

function getRank(score: number) {
  if (score >= 65) return "Top 1,000";
  if (score >= 55) return "Top 5,000";
  if (score >= 45) return "Top 15,000";
  if (score >= 35) return "Top 50,000";
  return "Above 1,00,000";
}

// ─── Start server ─────────────────────────────────
const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`RankSathi backend running on http://0.0.0.0:${PORT}`);
});
