/*
 * Lost Desk — campus lost-and-found.
 *
 * Web pages (login required): list / search, log a found item, open it,
 * update the record, mark it claimed or cleared, delete a bad entry, log out.
 * REST API (no login, as the brief allows): GET, POST, PUT, DELETE under /api/items.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { MONGODB_URI, SESSION_SECRET } = process.env;
const missingConfig = ["MONGODB_URI", "SESSION_SECRET"].filter(
  (name) => !process.env[name]?.trim()
);
if (missingConfig.length) {
  console.error(`Missing required configuration: ${missingConfig.join(", ")}. Set it in .env or the environment.`);
  process.exit(1);
}

const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { readCoverUpload } = require("./models/coverUpload");
const { createItemCsv } = require("./models/itemExport");

const User = require("./models/User");
const Item = require("./models/Item");
const { seedDatabase } = require("./models/seed");
const {
  CATEGORIES,
  PLACES,
  CAMPUSES,
  STATUSES,
  CATEGORY_LABELS,
  PLACE_LABELS,
  CAMPUS_LABELS,
  STATUS_LABELS,
  CODE_RE,
  cleanText,
  parseItemInput,
  buildFilter,
  presentItem,
  emptyFormValues,
  labelOf,
} = require("./models/itemRules");

const PORT = process.env.PORT || 8099;
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.locals.CATEGORIES = CATEGORIES;
app.locals.PLACES = PLACES;
app.locals.CAMPUSES = CAMPUSES;
app.locals.STATUSES = STATUSES;
app.locals.categoryLabel = (key) => labelOf(CATEGORY_LABELS, key);
app.locals.placeLabel = (key) => labelOf(PLACE_LABELS, key);
app.locals.campusLabel = (key) => labelOf(CAMPUS_LABELS, key);
app.locals.statusLabel = (key) => labelOf(STATUS_LABELS, key);
app.locals.desk = {
  place: "Student Union Activity Room",
  placeZh: "學生會活動室",
  building: "G/F, Campus Centre",
  hours: "Monday to Friday, 10:00–18:00",
  email: "hkmulostdesk@gmail.com",
  phone: "5406 4218",
};

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || "";
  delete req.session.flash;
  next();
});

function setFlash(req, message) {
  req.session.flash = message;
}

function isStudent(req) {
  return req.session.user && req.session.user.role === "student";
}

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  return res.redirect("/login");
}

function requireStaff(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!isStudent(req)) return next();
  setFlash(req, "Students can only look at items that are waiting to be claimed.");
  return res.redirect("/desk");
}

const STUDENT_ID_RE = /^s\d{7}$/;

function passwordRuleOk(password) {
  const letters = (String(password).match(/[A-Za-z]/g) || []).length;
  const digits = (String(password).match(/\d/g) || []).length;
  return letters >= 1 && digits >= 3;
}

function loginView(res, status, error) {
  return res.status(status).render("login", {
    title: "Sign in",
    error: error || "",
  });
}

function viewItem(doc, student) {
  const view = presentItem(doc);
  if (student) view.spot = "";
  view.hasCover = Boolean(doc.coverType);
  return view;
}

function signIn(req, res, next, user) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = {
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName,
      role: user.role || "staff",
    };
    return req.session.save(() => res.redirect("/desk"));
  });
}

async function uniqueCode(category) {
  const letterMatch = String(category || "").match(/[A-Za-z]/);
  const letter = letterMatch ? letterMatch[0].toUpperCase() : "X";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const digits = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    const code = `${letter}${digits}`;
    if (CODE_RE.test(code) && !(await Item.exists({ code }))) return code;
  }
  const error = new Error("Could not assign a reference number");
  error.status = 500;
  throw error;
}

function tally(rows) {
  return rows.reduce(
    (stats, row) => {
      stats.total += 1;
      stats[row.status] += 1;
      return stats;
    },
    { total: 0, stored: 0, claimed: 0, disposed: 0 }
  );
}

async function connectDatabase() {
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(MONGODB_URI);
  } catch (err) {
    console.error("Could not connect to MongoDB. Check MONGODB_URI and database access.");
    throw err;
  }
  console.log("MongoDB connected from configuration");
}

app.get("/", (req, res) => {
  res.redirect(req.session.user ? "/desk" : "/login");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/desk");
  return loginView(res, 200);
});

app.post("/login", async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 20).toLowerCase();
    const password = String(req.body.password || "");
    const user = await User.findOne({ username }).select("+passwordHash");
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return loginView(res, 401, "Username or password is not right.");
    return signIn(req, res, next, user);
  } catch (err) {
    return next(err);
  }
});

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/desk");
  res.render("register", { title: "Sign up", error: "", values: { username: "" } });
});

app.post("/register", async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 20).toLowerCase();
    const password = String(req.body.password || "");
    const confirm = String(req.body.confirm || "");
    const values = { username };
    const fail = (status, error) => res.status(status).render("register", { title: "Sign up", error, values });

    if (!STUDENT_ID_RE.test(username)) return fail(400, "Student ID must look like s1234567.");
    if (!passwordRuleOk(password)) return fail(400, "Password needs at least one letter and at least three numbers, such as test123.");
    if (password !== confirm) return fail(400, "The two passwords do not match.");

    await User.create({
      username,
      displayName: username,
      role: "student",
      passwordHash: await bcrypt.hash(password, 10),
    });
    setFlash(req, "Account created. Sign in to see what is waiting.");
    return res.redirect("/login");
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).render("register", {
        title: "Sign up",
        error: "That student ID is already registered.",
        values: { username: cleanText(req.body.username, 20).toLowerCase() },
      });
    }
    return next(err);
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

app.get("/manage/users", requireStaff, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q, 40).toLowerCase();
    const users = await User.find().select("username displayName role").sort({ username: 1 }).lean();
    const rows = users.filter((row) => [row.username, row.displayName].some((name) =>
      name && name.toLowerCase().includes(q)
    ));
    res.render("manage", { title: "User management", section: "users", rows, q });
  } catch (err) {
    next(err);
  }
});

app.get("/manage/categories", requireStaff, async (req, res, next) => {
  try {
    const counts = await Item.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]);
    const byCategory = new Map(counts.map(({ _id, count }) => [_id, count]));
    const rows = CATEGORIES.map((category) => ({ category, count: byCategory.get(category) ?? 0 }));
    res.render("manage", { title: "Category management", section: "categories", rows });
  } catch (err) {
    next(err);
  }
});

app.get("/desk", requireLogin, async (req, res, next) => {
  try {
    const student = isStudent(req);
    const query = student ? { ...req.query, status: "stored" } : req.query;
    const { filter, search } = buildFilter(query);
    const [allDocs, matchedDocs] = await Promise.all([
      Item.find().select("status"),
      Item.find(filter).sort({ foundOn: -1, name: 1 }),
    ]);
    const items = matchedDocs.map((doc) => viewItem(doc, student));
    const stats = tally(allDocs.map((doc) => ({ status: doc.status })));
    res.render("list", { title: student ? "Waiting" : "Desk", items, stats, search, showing: items.length, student });
  } catch (err) {
    return next(err);
  }
});

// Register this named route before /desk/:code so it is not treated as an item code.
app.get("/desk/export.csv", requireStaff, async (req, res, next) => {
  try {
    const { filter } = buildFilter(req.query);
    const docs = await Item.find(filter)
      .select("code name category place campus status foundOn spot description loggedBy")
      .sort({ foundOn: -1, name: 1 })
      .lean();
    res.set("Cache-Control", "private, no-store");
    res.attachment("lost-desk-items.csv");
    res.type("text/csv; charset=utf-8");
    return res.send(createItemCsv(docs));
  } catch (err) {
    return next(err);
  }
});

app.get("/desk/new", requireStaff, (req, res) => {
  res.render("edit", {
    title: "Log item",
    mode: "create",
    action: "/desk",
    error: "",
    values: emptyFormValues(),
  });
});

app.post("/desk", requireStaff, readCoverUpload, async (req, res, next) => {
  try {
    const { data, errors } = parseItemInput(req.body, "create");
    if (req.coverError) errors.unshift(req.coverError);
    if (errors.length) {
      return res.status(400).render("edit", {
        title: "Log item",
        mode: "create",
        action: "/desk",
        error: errors[0],
        values: { ...emptyFormValues(), ...req.body, code: cleanText(req.body.code, 20).toUpperCase() },
      });
    }
    data.code = await uniqueCode(data.category);
    data.loggedBy = "Staff";
    await Item.create({ ...data, ...req.cover });
    setFlash(req, `${data.name} is logged as ${data.code}.`);
    return res.redirect("/desk");
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).render("edit", {
        title: "Log item",
        mode: "create",
        action: "/desk",
        error: "That tag code is already used. Leave it blank to auto-assign one.",
        values: { ...emptyFormValues(), ...req.body },
      });
    }
    return next(err);
  }
});

app.get("/desk/:code/cover", requireLogin, async (req, res, next) => {
  try {
    const filter = { code: req.params.code.toUpperCase() };
    if (isStudent(req)) filter.status = "stored";
    const item = await Item.findOne(filter).select("coverType +coverBytes");
    if (!item?.coverBytes || !item.coverType) return res.sendStatus(404);
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    return res.type(item.coverType).send(item.coverBytes);
  } catch (err) {
    next(err);
  }
});

app.get("/desk/:code", requireLogin, async (req, res, next) => {
  try {
    const item = await Item.findOne({ code: req.params.code.toUpperCase() });
    if (!item) {
      return res.status(404).render("message", {
        title: "Not found",
        heading: "That tag is not on the desk",
        detail: "It may have been deleted. Go back and search again.",
      });
    }
    if (isStudent(req) && item.status !== "stored") {
      setFlash(req, "That item is no longer waiting to be claimed.");
      return res.redirect("/desk");
    }
    return res.render("details", { title: item.name, item: viewItem(item, isStudent(req)), student: isStudent(req) });
  } catch (err) {
    return next(err);
  }
});

app.get("/desk/:code/edit", requireStaff, async (req, res, next) => {
  try {
    const item = await Item.findOne({ code: req.params.code.toUpperCase() });
    if (!item) return res.redirect("/desk");
    const view = viewItem(item, false);
    return res.render("edit", {
      title: `Edit ${view.name}`,
      mode: "edit",
      action: `/desk/${view.code}/update`,
      error: "",
      values: view,
    });
  } catch (err) {
    return next(err);
  }
});

app.post("/desk/:code/update", requireStaff, readCoverUpload, async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const existing = await Item.findOne({ code });
    if (!existing) return res.redirect("/desk");
    const { data, errors } = parseItemInput(req.body, "create");
    if (req.coverError) errors.unshift(req.coverError);
    if (errors.length) {
      return res.status(400).render("edit", {
        title: `Edit ${existing.name}`,
        mode: "edit",
        action: `/desk/${code}/update`,
        error: errors[0],
        values: { ...viewItem(existing, false), ...req.body, code, hasCover: Boolean(existing.coverType) },
      });
    }
    data.loggedBy = existing.loggedBy;
    const update = { $set: { ...data, ...req.cover } };
    if (!req.cover && req.body.removeCover === "1") {
      update.$unset = { coverBytes: 1, coverType: 1 };
    }
    await Item.updateOne({ code }, update);
    setFlash(req, `${data.name} was updated.`);
    return res.redirect(`/desk/${code}`);
  } catch (err) {
    return next(err);
  }
});

app.post("/desk/:code/status", requireStaff, async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const status = cleanText(req.body.status, 20);
    if (!STATUSES.includes(status)) return res.redirect(`/desk/${code}`);
    const existing = await Item.findOne({ code });
    if (!existing) return res.redirect("/desk");
    existing.status = status;
    await existing.save();
    const word = status === "claimed" ? "marked claimed" : status === "disposed" ? "cleared from the shelf" : "put back on the shelf";
    setFlash(req, `${existing.name} was ${word}.`);
    return res.redirect(`/desk/${code}`);
  } catch (err) {
    return next(err);
  }
});

app.post("/desk/:code/delete", requireStaff, async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const existing = await Item.findOne({ code });
    if (!existing) return res.redirect("/desk");
    await Item.deleteOne({ code });
    setFlash(req, `${existing.name} (${code}) was removed.`);
    return res.redirect("/desk");
  } catch (err) {
    return next(err);
  }
});

// READ many, with the same filters as the desk page.
// curl -s "http://localhost:8099/api/items?category=electronics&status=stored"
app.get("/api/items", async (req, res, next) => {
  try {
    const { filter } = buildFilter(req.query);
    const docs = await Item.find(filter).sort({ foundOn: -1, name: 1 });
    return res.json(docs.map(presentItem));
  } catch (err) {
    return next(err);
  }
});

// curl -s http://localhost:8099/api/items/K184206
app.get("/api/items/:code", async (req, res, next) => {
  try {
    const item = await Item.findOne({ code: req.params.code.toUpperCase() });
    if (!item) return res.status(404).json({ error: "No item with that tag code." });
    return res.json(presentItem(item));
  } catch (err) {
    return next(err);
  }
});

// curl -s -X POST http://localhost:8099/api/items -H "Content-Type: application/json" -d "{\"name\":\"Black cap\",\"category\":\"clothing\",\"place\":\"library\",\"campus\":\"MC\",\"status\":\"stored\",\"foundOn\":\"2026-11-05\",\"spot\":\"Bin B3\"}"
app.post("/api/items", async (req, res, next) => {
  try {
    const { data, errors } = parseItemInput(req.body, "create");
    if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
    data.code = await uniqueCode(data.category);
    const who = cleanText(req.body.loggedBy, 40);
    data.loggedBy = who === "Student" ? "Student" : "Staff";
    const created = await Item.create(data);
    return res.status(201).json(presentItem(created));
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: "That tag code is already used." });
    return next(err);
  }
});

// curl -s -X PUT http://localhost:8099/api/items/C482910 -H "Content-Type: application/json" -d "{\"status\":\"claimed\",\"description\":\"Owner collected it at the desk\"}"
app.put("/api/items/:code", async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const existing = await Item.findOne({ code });
    if (!existing) return res.status(404).json({ error: "No item with that tag code." });
    const { data, errors } = parseItemInput(req.body, "patch");
    if (errors.length) return res.status(400).json({ error: errors[0], details: errors });
    Object.assign(existing, data);
    await existing.save();
    return res.json(presentItem(existing));
  } catch (err) {
    return next(err);
  }
});

// curl -s -X DELETE http://localhost:8099/api/items/C482910
app.delete("/api/items/:code", async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const existing = await Item.findOne({ code });
    if (!existing) return res.status(404).json({ error: "No item with that tag code." });
    await Item.deleteOne({ code });
    return res.json({ deleted: true, code, name: existing.name });
  } catch (err) {
    return next(err);
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "No such API route." });
  return res.status(404).render("message", {
    title: "Not found",
    heading: "That page is not on the desk",
    detail: `${req.path} is not a Lost Desk page.`,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed" || req.path.startsWith("/api/")) {
    const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
    const error = err.type === "entity.parse.failed" ? "Request body is not valid JSON." : "Server error.";
    return res.status(status).json({ error });
  }
  return res.status(500).render("message", {
    title: "Server error",
    heading: "The desk hit a problem",
    detail: "Try the page again. If it keeps failing, check the server log.",
  });
});

async function start() {
  await connectDatabase();
  await seedDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Lost Desk listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Lost Desk failed to start.");
  console.error(err.name || "Error");
  process.exit(1);
});
