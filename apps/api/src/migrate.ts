import { migrate } from "./db.js";

migrate();
console.log("SQLite migrations applied.");
