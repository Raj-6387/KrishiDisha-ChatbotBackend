import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

/* ================= MIDDLEWARE ================= */

app.use(cors());

app.use(express.json({ limit: "20mb" }));

app.use(express.urlencoded({
  limit: "20mb",
  extended: true
}));

/* ================= DATABASE ================= */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ DB Error:", err));



/* ================= USER MODEL ================= */

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    default: "Farmer"
  },

  email: {
    type: String,
    unique: true,
    sparse: true
  },

  phone: {
    type: String,
    unique: true,
    sparse: true
  },

  password: String,

  farmerId: {
    type: String,
    default: () =>
      "FD" + Math.floor(1000 + Math.random() * 9000)
  },

  photo: {
    type: String,
    default: ""
  }
});

const User = mongoose.model("User", userSchema);

/* ================= SEARCH HISTORY MODEL ================= */

const searchHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  type: {
    type: String,
    enum: ["crop", "fertilizer"],
    required: true
  },
  inputs: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  result: mongoose.Schema.Types.Mixed,
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const SearchHistory = mongoose.model("SearchHistory", searchHistorySchema);

/* ================= CHAT THREAD MODEL ================= */

const chatThreadSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  title: {
    type: String,
    default: "New Chat"
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const ChatThread = mongoose.model("ChatThread", chatThreadSchema);

/* ================= CHAT MESSAGE MODEL ================= */

const chatMessageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  threadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatThread",
    required: true
  },
  role: {
    type: String,
    enum: ["user", "bot"],
    required: true
  },
  text: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

app.post("/chat", async (req, res) => {
  try {
    const { message, threadId } = req.body;

    // Optional JWT verification to save chats for logged-in users
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch (jwtErr) {
        console.log("Optional JWT validation failed:", jwtErr.message);
      }
    }

    let activeThreadId = threadId;
    if (userId) {
      if (!activeThreadId) {
        // Auto-generate title from first prompt
        const title = message.trim().substring(0, 30) + (message.trim().length > 30 ? "..." : "");
        const thread = await ChatThread.create({
          userId,
          title
        });
        activeThreadId = thread._id;
      }

      await ChatMessage.create({
        userId,
        threadId: activeThreadId,
        role: "user",
        text: message
      });
    }

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:5173",
          "X-Title": "KrishiDisha"
        },
        body: JSON.stringify({
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "You are a farming expert. Answer in simple Hindi or English."
            },
            {
              role: "user",
              content: message
            }
          ]
        })
      }
    );

    const data = await response.json();

    console.log(
      "FULL AI RESPONSE:",
      JSON.stringify(data, null, 2)
    );

    let reply = "⚠️ No response from AI";

    if (data?.choices?.length > 0) {
      reply = data.choices[0].message?.content || reply;
    }
    else if (data?.error) {
      reply = "❌ " + data.error.message;
    }

    if (userId && activeThreadId) {
      await ChatMessage.create({
        userId,
        threadId: activeThreadId,
        role: "bot",
        text: reply
      });
    }

    res.json({ reply, threadId: activeThreadId });

  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({
      reply: "AI error occurred"
    });
  }
});

/* ================= HISTORY API ROUTES ================= */

// 🔍 Save Crop/Fertilizer Search History
app.post("/api/history/search", verifyToken, async (req, res) => {
  try {
    const { type, inputs, result } = req.body;
    
    if (!type || !inputs || !result) {
      return res.status(400).json({ msg: "Missing fields" });
    }

    const search = await SearchHistory.create({
      userId: req.user.id,
      type,
      inputs,
      result
    });

    res.json(search);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to save search history" });
  }
});

// 🔍 Get Search History
app.get("/api/history/search", verifyToken, async (req, res) => {
  try {
    const history = await SearchHistory.find({ userId: req.user.id })
      .sort({ timestamp: -1 })
      .limit(50);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to fetch search history" });
  }
});

// 💬 Get Chat History
app.get("/api/history/chat", verifyToken, async (req, res) => {
  try {
    const chats = await ChatMessage.find({ userId: req.user.id })
      .sort({ timestamp: 1 })
      .limit(100);
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to fetch chat history" });
  }
});

// 🧵 Get Chat Threads
app.get("/api/history/chat/threads", verifyToken, async (req, res) => {
  try {
    const threads = await ChatThread.find({ userId: req.user.id }).sort({ timestamp: -1 });
    res.json(threads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to fetch chat threads" });
  }
});

// 📂 Get Chat Messages in a Thread
app.get("/api/history/chat/messages/:threadId", verifyToken, async (req, res) => {
  try {
    const messages = await ChatMessage.find({
      userId: req.user.id,
      threadId: req.params.threadId
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to fetch thread messages" });
  }
});

// ✏️ Rename Chat Thread
app.put("/api/history/chat/threads/:id", verifyToken, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ msg: "Title is required" });

    const thread = await ChatThread.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { title },
      { new: true }
    );

    if (!thread) return res.status(404).json({ msg: "Thread not found" });
    res.json(thread);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to rename thread" });
  }
});

// 🗑️ Delete Chat Thread and its messages
app.delete("/api/history/chat/threads/:id", verifyToken, async (req, res) => {
  try {
    const thread = await ChatThread.findOne({ _id: req.params.id, userId: req.user.id });
    if (!thread) return res.status(404).json({ msg: "Thread not found" });

    await ChatThread.deleteOne({ _id: req.params.id });
    await ChatMessage.deleteMany({ threadId: req.params.id });

    res.json({ msg: "Thread and messages deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to delete thread" });
  }
});

// 🗑️ Delete Search History Entry
app.delete("/api/history/search/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const search = await SearchHistory.findOne({ _id: id, userId: req.user.id });
    
    if (!search) {
      return res.status(404).json({ msg: "History item not found" });
    }

    await SearchHistory.deleteOne({ _id: id });
    res.json({ msg: "History item deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to delete history item" });
  }
});

/* ================= SIGNUP ================= */

app.post("/signup", async (req, res) => {

  try {

    const { name, email, phone, password } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        msg: "Please provide either an email or a phone number"
      });
    }

    let exist = null;
    if (email) {
      exist = await User.findOne({ email });
    }
    if (!exist && phone) {
      exist = await User.findOne({ phone });
    }

    if (exist) {
      return res.status(400).json({
        msg: "User with this email or phone number already exists"
      });
    }

    const hashedPassword =
      await bcrypt.hash(password, 10);

    await User.create({
      name: name || "Farmer",
      email: email || undefined,
      phone: phone || undefined,
      password: hashedPassword
    });

    res.json({
      msg: "Signup successful"
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      msg: "Signup error"
    });
  }
});

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {

  try {

    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ msg: "Please enter your Email or Phone Number" });
    }

    const user = await User.findOne({
      $or: [
        { email: email },
        { phone: email }
      ]
    });

    if (!user) {
      return res.status(400).json({
        msg: "User not found"
      });
    }

    const match =
      await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(400).json({
        msg: "Wrong password"
      });
    }

    // 🔥 JWT TOKEN
    const token = jwt.sign(
      {
        id: user._id,
        email: user.email || user.phone
      },

      process.env.JWT_SECRET,

      {
        expiresIn: "7d"
      }
    );

    res.json({

      token,

      user: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        farmerId: user.farmerId,
        photo: user.photo
      }
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      msg: "Login error"
    });
  }
});

/* ================= FORGOT PASSWORD ================= */

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ msg: "Please enter your Email or Phone Number" });
    }

    const user = await User.findOne({
      $or: [
        { email: email },
        { phone: email }
      ]
    });

    if (!user) {
      return res.status(404).json({ msg: "No account found with this identifier" });
    }

    // Mock send instructions response
    res.json({
      msg: `Password reset instructions have been sent to your registered address: ${email}`
    });

  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ msg: "Forgot password processing error" });
  }
});

/* ================= VERIFY TOKEN ================= */

function verifyToken(req, res, next) {

  const authHeader = req.headers.authorization;

  // No header
  if (!authHeader) {
    return res.status(401).json({
      msg: "No token provided"
    });
  }

  // Extract token
  const token = authHeader.split(" ")[1];

  // No token
  if (!token) {
    return res.status(401).json({
      msg: "Token missing"
    });
  }

  try {

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;

    next();

  } catch (err) {

    console.error("JWT ERROR:", err);

    // Expired token
    if (err.name === "TokenExpiredError") {

      return res.status(401).json({
        msg: "Token expired. Please login again."
      });
    }

    // Invalid token
    if (err.name === "JsonWebTokenError") {

      return res.status(401).json({
        msg: "Invalid token"
      });
    }

    // Other errors
    return res.status(500).json({
      msg: "Authentication failed"
    });
  }
};

/* ================= UPDATE PROFILE ================= */

app.put("/profile", verifyToken, async (req, res) => {

  try {

    const { name, photo } = req.body;

    const user =
      await User.findByIdAndUpdate(

        req.user.id,

        {
          name,
          photo
        },

        {
          new: true
        }
      );

    res.json({
      name: user.name,
      email: user.email,
      farmerId: user.farmerId,
      photo: user.photo
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      msg: "Profile update failed"
    });
  }
});

/* ================= LOAD MANDI JSON ================= */

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const filePath = path.join(
  __dirname,
  "data",
  "mandiprice.json"
);

let records = [];

try {

  const rawData =
    fs.readFileSync(filePath, "utf-8");

  const jsonData = JSON.parse(rawData);

  records = jsonData.records || [];

  console.log(
    "✅ JSON Loaded:",
    records.length,
    "records"
  );

} catch (error) {

  console.error(
    "❌ JSON Load Error:",
    error.message
  );
}

/* ================= API ROUTE ================= */

app.get("/api/data", (req, res) => {
  res.json(records);
});

/* ================= SERVER ================= */



const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});



