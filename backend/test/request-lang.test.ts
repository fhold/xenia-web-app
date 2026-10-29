/**
 * Fehlermeldungen in der Sprache des Geraets: das Frontend legt sie im Cookie
 * `xenia_lang` ab, der Server antwortet je Anfrage in dieser Sprache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { langFromCookie, registerRequestLang } from "../src/lib/request-lang.js";
import { L, setRequestLangSource, withSharedLang } from "../../shared/src/shared-lang.js";

test("Cookie: xenia_lang wird gelesen, alles andere ignoriert", () => {
  assert.equal(langFromCookie("xenia_lang=en"), "en");
  assert.equal(langFromCookie("foo=1; xenia_lang=de; bar=2"), "de");
  assert.equal(langFromCookie("xenia_lang=fr"), undefined);
  assert.equal(langFromCookie("other_xenia_lang=en"), undefined);
  assert.equal(langFromCookie(undefined), undefined);
});

test("Antwort in der Sprache des Cookies, ohne Cookie Deutsch — auch bei gleichzeitigen Anfragen", async () => {
  const app = Fastify({ logger: false });
  registerRequestLang(app);
  app.get("/t", async () => {
    // Eine Pause dazwischen: die Sprache muss die await-Grenze ueberstehen,
    // waehrend eine andere Anfrage in ihrer Sprache laeuft.
    await new Promise((r) => setTimeout(r, 20));
    return { error: L("Bezug nicht gefunden", "Shot not found") };
  });
  try {
    const [en, de, none] = await Promise.all([
      app.inject({ method: "GET", url: "/t", headers: { cookie: "xenia_lang=en" } }),
      app.inject({ method: "GET", url: "/t", headers: { cookie: "xenia_lang=de" } }),
      app.inject({ method: "GET", url: "/t" }),
    ]);
    assert.equal(en.json().error, "Shot not found");
    assert.equal(de.json().error, "Bezug nicht gefunden");
    assert.equal(none.json().error, "Bezug nicht gefunden");
  } finally {
    await app.close();
    setRequestLangSource(null);
  }
});

test("withSharedLang gibt die Sprache auch innerhalb einer Anfrage vor", () => {
  setRequestLangSource(() => "en");
  try {
    assert.equal(L("Fluss", "Flow"), "Flow");
    assert.equal(withSharedLang("de", () => L("Fluss", "Flow")), "Fluss");
  } finally {
    setRequestLangSource(null);
  }
});
