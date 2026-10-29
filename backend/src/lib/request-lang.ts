/**
 * Sprache je Anfrage: Das Frontend legt die Sprache der Oberflaeche im Cookie
 * `xenia_lang` ab (frontend/src/i18n/index.ts), der Browser schickt ihn mit jeder
 * Anfrage mit. Die Anfrage laeuft dann in dieser Sprache — Fehlermeldungen per
 * L("…", "…") kommen so in der Sprache des Geraets an, das gefragt hat. Ohne
 * Cookie (Tests, curl, Arbeit ausserhalb einer Anfrage) gilt der Standard aus
 * shared-lang (Deutsch).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { setRequestLangSource, type SharedLang } from "../../../shared/src/shared-lang.js";

const store = new AsyncLocalStorage<SharedLang>();

export function langFromCookie(cookie: string | undefined): SharedLang | undefined {
  const m = /(?:^|;\s*)xenia_lang=(de|en)(?:;|$)/.exec(cookie ?? "");
  return m ? (m[1] as SharedLang) : undefined;
}

export function registerRequestLang(app: FastifyInstance): void {
  setRequestLangSource(() => store.getStore());
  app.addHook("onRequest", (req, _reply, done) => {
    const lang = langFromCookie(req.headers.cookie);
    if (lang) store.run(lang, done);
    else done();
  });
}
