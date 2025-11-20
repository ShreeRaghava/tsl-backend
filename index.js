
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- MongoDB connection (with in-memory fallback) ----------
let mongoUri = process.env.MONGO_URI;
// Treat placeholder values as unset (common when user copied .env.example)
if (mongoUri && mongoUri.includes('<')) {
  console.warn('Detected placeholder MONGO_URI in .env — ignoring and using in-memory store.');
  mongoUri = undefined;
}
let useDb = false;

// Simple in-memory stores used when Mongo isn't configured/available
const memory = {
  businesses: [],
  customers: [],
  pilots: []
};
function genId() {
  return String(Date.now()) + Math.floor(Math.random() * 10000);
}

if (!mongoUri) {
  console.warn("⚠️  MONGO_URI not set in .env — running with in-memory data store (non-persistent)");
  useDb = false;
} else {
  mongoose
    .connect(mongoUri, { dbName: "tsl" })
    .then(() => {
      useDb = true;
      console.log("✅ Connected to MongoDB");
    })
    .catch((err) => {
      console.error("MongoDB connection error:", err.message);
      console.warn("Falling back to in-memory store (server will still run)");
      useDb = false;
    });
}

// ---------- Schemas & Models ----------

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },          // e.g. Maya Dental Clinic
    ownerName: { type: String },
    email: { type: String },
    phone: { type: String },
    businessType: { type: String },                  // clinic, gym, restaurant, etc.
    googleReviewLink: { type: String },              // direct review URL
    pilotActive: { type: Boolean, default: false },
    pilotStartDate: { type: Date },
    pilotEndDate: { type: Date }
  },
  { timestamps: true }
);

const customerSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    name: { type: String },
    phone: { type: String, required: true },
    lastVisitDate: { type: Date },
    reviewRequestSentAt: { type: Date },
    reviewLinkClickedAt: { type: Date },
    negativeFeedback: { type: String },   // optional
    status: {
      type: String,
      enum: ["pending", "requested", "reviewed", "bad_experience"],
      default: "pending"
    }
  },
  { timestamps: true }
);

const pilotLeadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },         // contact person
    businessName: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    businessType: { type: String },
    notes: { type: String },
    convertedToBusiness: { type: Boolean, default: false }
  },
  { timestamps: true }
);

const Business = mongoose.model("Business", businessSchema);
const Customer = mongoose.model("Customer", customerSchema);
const PilotLead = mongoose.model("PilotLead", pilotLeadSchema);

// ---------- WhatsApp helper ----------

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "review_request";
const WA_TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

async function sendWhatsAppTemplate({ to, templateName, components = [] }) {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
    console.warn("WhatsApp credentials not set. Skipping send for", to);
    return;
  }

  const url = `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName || WA_TEMPLATE_NAME,
      language: { code: WA_TEMPLATE_LANGUAGE },
      components
    }
  };

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("✅ WhatsApp message sent to", to, res.data.messages?.[0]?.id || "");
  } catch (err) {
    console.error(
      "❌ WhatsApp send failed for",
      to,
      err.response?.data || err.message
    );
  }
}

// ---------- Routes ----------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "TSL backend running" });
});

// 1) Pilot lead – from landing page
app.post("/api/pilot", async (req, res) => {
  try {
    const { name, businessName, phone, email, businessType, notes } = req.body;

    if (!name || !businessName || !phone) {
      return res.status(400).json({ error: "name, businessName & phone required" });
    }

    let lead;
    if (useDb) {
      lead = await PilotLead.create({ name, businessName, phone, email, businessType, notes });
    } else {
      lead = { _id: genId(), name, businessName, phone, email, businessType, notes, createdAt: new Date() };
      memory.pilots.push(lead);
    }

    // Optional: send WhatsApp confirmation to the lead
    await sendWhatsAppTemplate({
      to: phone,
      templateName: WA_TEMPLATE_NAME, // must exist in your WA Cloud account
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: name || "there" },
            { type: "text", text: businessName }
          ]
        }
      ]
    });

    res.json({ ok: true, leadId: lead._id });
  } catch (err) {
    console.error("POST /api/pilot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2) Create business (you will call via Postman now)
app.post("/api/businesses", async (req, res) => {
  try {
    const data = req.body;
    if (!data.name) {
      return res.status(400).json({ error: "Business name required" });
    }

    let business;
    if (useDb) {
      business = await Business.create(data);
    } else {
      business = { _id: genId(), ...data, createdAt: new Date() };
      memory.businesses.push(business);
    }
    res.json({ ok: true, business });
  } catch (err) {
    console.error("POST /api/businesses error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3) Import customers for a business
app.post("/api/customers/import", async (req, res) => {
  try {
    const { businessId, customers } = req.body;

    if (!businessId || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: "businessId and customers[] required" });
    }

    const docs = customers.map((c) => ({
      business: businessId,
      name: c.name || "",
      phone: c.phone,
      lastVisitDate: c.lastVisitDate ? new Date(c.lastVisitDate) : undefined
    }));

    if (useDb) {
      const inserted = await Customer.insertMany(docs);
      res.json({ ok: true, inserted: inserted.length });
    } else {
      const inserted = docs.map((d) => ({ _id: genId(), ...d, createdAt: new Date() }));
      memory.customers.push(...inserted);
      res.json({ ok: true, inserted: inserted.length });
    }
  } catch (err) {
    console.error("POST /api/customers/import error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4) Send review requests for a business
app.post("/api/campaigns/:businessId/send-review-requests", async (req, res) => {
  try {
    const { businessId } = req.params;
    let business;
    if (useDb) {
      business = await Business.findById(businessId);
    } else {
      business = memory.businesses.find((b) => String(b._id) === String(businessId));
    }
    if (!business) return res.status(404).json({ error: "Business not found" });

    let customers;
    if (useDb) {
      customers = await Customer.find({ business: businessId, status: "pending" }).limit(200);
    } else {
      customers = memory.customers.filter((c) => String(c.business) === String(businessId) && (c.status || 'pending') === 'pending').slice(0, 200);
    }

    const googleLink =
      business.googleReviewLink ||
      "https://search.google.com/local/writereview?placeid=YOUR_PLACE_ID";

    // Send messages sequentially (simple & safe)
    for (const cust of customers) {
      if (!cust.phone) continue;

      const bodyText =
        `Hi ${cust.name || "there"}, this is ${business.name}. ` +
        `Thank you for your recent visit. Could you take a moment to leave us a quick review on Google? ` +
        `${googleLink}`;

      await sendWhatsAppTemplate({
        to: cust.phone,
        templateName: WA_TEMPLATE_NAME,
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: cust.name || "there" },
              { type: "text", text: business.name },
              { type: "text", text: googleLink }
            ]
          }
        ]
      });

      // update status in DB or in-memory
      if (useDb) {
        cust.status = "requested";
        cust.reviewRequestSentAt = new Date();
        await cust.save();
      } else {
        const mem = memory.customers.find((m) => String(m._id) === String(cust._id));
        if (mem) {
          mem.status = 'requested';
          mem.reviewRequestSentAt = new Date();
        }
      }
    }

    res.json({ ok: true, requested: customers.length, message: "Review requests queued (best-effort on WhatsApp API)." });
  } catch (err) {
    console.error("POST /api/campaigns/:businessId/send-review-requests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 5) Simple summary
app.get("/api/businesses/:id/summary", async (req, res) => {
  try {
    const { id } = req.params;

    if (useDb) {
      const total = await Customer.countDocuments({ business: id });
      const requested = await Customer.countDocuments({ business: id, status: "requested" });
      const reviewed = await Customer.countDocuments({ business: id, status: "reviewed" });
      const bad = await Customer.countDocuments({ business: id, status: "bad_experience" });
      res.json({ ok: true, total, requested, reviewed, bad });
    } else {
      const list = memory.customers.filter((c) => String(c.business) === String(id));
      const total = list.length;
      const requested = list.filter((c) => c.status === 'requested').length;
      const reviewed = list.filter((c) => c.status === 'reviewed').length;
      const bad = list.filter((c) => c.status === 'bad_experience').length;
      res.json({ ok: true, total, requested, reviewed, bad });
    }
  } catch (err) {
    console.error("GET /api/businesses/:id/summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Start server ----------
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 TSL backend listening on port ${port}`);
});
