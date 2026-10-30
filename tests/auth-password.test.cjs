const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");

const worker = fs.readFileSync("Index.ts", "utf8");
const start = worker.indexOf("const PBKDF2_ITERATIONS = 100000;");
const end = worker.indexOf("\nasync function sessionTokenHash", start);
assert.notEqual(start, -1, "Constante PBKDF2 absente.");
assert.notEqual(end, -1, "Fonctions de hachage incomplètes.");

const helperSource = worker.slice(start, end) +
  "\nglobalThis.__authTest = { passwordHash, verifyPassword };";
const sandbox = { crypto: webcrypto, TextEncoder, Uint8Array, Array, Number, RegExp };
vm.runInNewContext(helperSource, sandbox, { timeout: 5000 });

async function main() {
  const password = "NKJJEAN-Test-Password-2026!";
  const currentHash = await sandbox.__authTest.passwordHash(password);
  const parts = currentHash.split("$");

  assert.equal(parts.length, 4, "Le nouveau hachage doit contenir 4 parties.");
  assert.equal(parts[0], "pbkdf2-sha256");
  assert.equal(parts[1], "100000");
  assert.equal(await sandbox.__authTest.verifyPassword(password, currentHash), true);
  assert.equal(await sandbox.__authTest.verifyPassword("mauvais-mot-de-passe", currentHash), false);

  // Les comptes créés avec l'ancien format sans séparateurs doivent rester accessibles.
  const legacyHash = "pbkdf2-sha256" + parts[1] + parts[2] + parts[3];
  assert.equal(await sandbox.__authTest.verifyPassword(password, legacyHash), true);
  assert.equal(await sandbox.__authTest.verifyPassword("mauvais-mot-de-passe", legacyHash), false);

  console.log("Tests PBKDF2 réussis : nouveau format, ancien format et mauvais mot de passe.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
