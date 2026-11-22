// deno test --allow-env --config deno.json tests/
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
const { generateCode, hashCode, matchCode } = await import("../_shared/codes.ts");

const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

Deno.test("codes are numeric with the requested length", () => {
  for (const len of [6, 8, 12]) {
    for (let i = 0; i < 200; i++) {
      const c = generateCode(len);
      assert(c.length === len && /^\d+$/.test(c), `bad code ${len}`);
    }
  }
});

Deno.test("rejects lengths outside 6–12", () => {
  for (const len of [0, 5, 13]) {
    let threw = false;
    try { generateCode(len); } catch { threw = true; }
    assert(threw, `length ${len} accepted`);
  }
});

Deno.test("digit distribution is uniform (no modulo bias)", () => {
  const counts = new Array(10).fill(0);
  const N = 200_000;
  let total = 0;
  while (total < N) { for (const d of generateCode(12)) { counts[+d]++; total++; } }
  const expected = total / 10;
  const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  assert(chi2 < 30, `chi-square too high: ${chi2.toFixed(1)}`); // df=9, p≈0.0004
});

Deno.test("hash is bcrypt and never contains the code", () => {
  const code = generateCode(8);
  const h = hashCode(code);
  assert(/^\$2[aby]\$10\$/.test(h), "not bcrypt cost 10");
  assert(!h.includes(code), "hash contains code");
  assert(hashCode(code) !== h, "salt not random");
});

Deno.test("matchCode finds the right profile and only active-agnostic match", () => {
  const a = generateCode(8), b = generateCode(8);
  const cands = [
    { profile_id: "A", code_hash: hashCode(a), active: true },
    { profile_id: "B", code_hash: hashCode(b), active: false },
  ];
  assert(matchCode(a, cands)?.profile_id === "A", "A not matched");
  assert(matchCode(b, cands)?.profile_id === "B", "B not matched");
  assert(matchCode("99999999" === a ? "88888888" : "99999999", cands) === null, "wrong code matched");
  assert(matchCode(a, []) === null, "empty list matched");
});
