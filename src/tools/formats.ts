import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { listProfiles, minimumExamples, normalizeSenderKey, parseProfile, removeProfile, sampleSchema, saveProfile, testProfile } from "../domain/profiles.js";
import { listSenders } from "../domain/senders.js";
import { resolveParser } from "../parsers/resolve.js";
import { run } from "./helpers.js";

const FORMAT_GUIDE =
  "Aprender un banco nuevo (cualquier país): 1) Busca en el correo del usuario 4 comprobantes REALES de ese remitente, de tipos distintos (una compra, un pago o transferencia, un ingreso y, si hay, un aviso que NO sea movimiento como un login). " +
  "2) Muéstrale al usuario cómo interpretaste cada uno (fecha, monto, comercio, tipo) y pídele que confirme o corrija: esa confirmación es la verdad con la que se prueban las reglas. " +
  "3) Redacta las reglas (profile) y llama a esta herramienta con dryRun:true y los ejemplos confirmados; si algún ejemplo falla, corrige las reglas y repite hasta que todos pasen. " +
  "4) Recién ahí llama sin dryRun para guardarlas. Pasa en cada ejemplo solo la parte relevante del texto (sin avisos legales).";

const profileHelp =
  "profile = { bank:'galicia', currency:'ARS', timezone:'America/Argentina/Buenos_Aires', dateFormats:['DD/MM/YYYY'], endMarkers:['Aviso legal'], " +
  "templates:[{ name, subjectContains:['Compra'], bodyContains:[], action:'register'|'skip', skipReason, kind:'gasto'|'ingreso'|'transferencia_propia', " +
  "amount:{label:'Importe'}, merchant:{label:'Comercio'}, date:{label:'Fecha'}, delimiters:['Hora','Tarjeta'], endMarkers:[] }] }. " +
  "Cada valor se extrae con {label:'Texto exacto de la etiqueta'} (lo que sigue a esa etiqueta hasta la siguiente), {regex:'patrón con un grupo de captura'} o {fixed:'Texto fijo'}. " +
  "Lista en delimiters las demás etiquetas del comprobante para que cada valor se corte donde empieza la siguiente. Una plantilla con action:'skip' descarta avisos que no son movimientos. " +
  "Los importes en otra moneda se reportan y no se registran. " +
  "Comprobantes en dólares (u otra moneda) de un comercio que cobra por otro canal: profile.currency:'USD' y foreignCurrency:'convert' convierten el importe a pesos con la tasa oficial del día y lo marcan como estimado (si el banco ya avisó ese cobro, no se cuenta dos veces); en el ejemplo esperado usa {date, merchant, kind, foreign:{currency:'USD', value:20}}. " +
  "Recibos que solo dicen en qué se gastó algo que el banco reporta con un nombre genérico (por ejemplo Apple.com/bill): template con action:'detail', matchMerchant:['apple.com/bill'] (qué comercios del banco puede describir), amount (total), date y merchant (la descripción del producto); no crea movimientos, le agrega el detalle al que coincide en monto y fecha (±3 días); el ejemplo esperado es {detail:{date, amount, description}}. " +
  "dateFormats también admite 'MMM D, YYYY' (November 5, 2026).";

export function registerFormatTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    "formatos_banco",
    {
      description:
        "Lista cómo sabe leer este servidor los comprobantes de cada banco: formatos incluidos (BBVA Colombia), formatos aprendidos de los ejemplos del usuario, y los remitentes autorizados que todavía NO tienen reglas. " +
        "Si hay remitentes sin reglas, hay que aprenderlos antes de sincronizar. " + FORMAT_GUIDE,
    },
    () =>
      run(() => ({
        builtIn: [{ bank: "bbva", country: "CO", senders: ["@bbvanet.com.co", "@bbva.com.co", "@bbva.com"] }],
        learned: listProfiles(db).map((p) => ({
          sender: p.sender, bank: p.profile.bank, currency: p.profile.currency,
          templates: p.profile.templates.map((t) => t.name), examplesUsed: p.samples, updatedAt: p.updatedAt,
        })),
        authorizedWithoutFormat: listSenders(db).map((s) => s.address).filter((a) => resolveParser(db, a) === null),
      })),
  );

  server.registerTool(
    "configurar_formato_banco",
    {
      description:
        "Enseña al servidor a leer los comprobantes de un banco a partir de ejemplos reales confirmados por el usuario, y guarda las reglas SOLO si todos los ejemplos pasan. " +
        `Exige al menos 3 ejemplos (idealmente 4, de tipos distintos) salvo con dryRun:true, que solo prueba y no guarda; si el remitente manda un solo tipo de aviso (una sola plantilla, por ejemplo una dirección que solo envía recibos), alcanza con 1. ` +
        "sender es una dirección (avisos@banco.com) o un dominio (banco.com). Las reglas aprendidas tienen prioridad sobre las incluidas, así que sirve también para corregir un banco cuando cambia el formato de sus correos. " +
        "Devuelve {saved, results:[{index, pass, problems, got}]}: si algo falla, corrige las reglas según problems y vuelve a llamar. " + profileHelp + " " + FORMAT_GUIDE,
      inputSchema: {
        sender: z.string().min(3).max(120),
        profile: z.record(z.string(), z.unknown()),
        samples: z.array(sampleSchema).min(1).max(12),
        dryRun: z.boolean().optional(),
      },
    },
    ({ sender, profile, samples, dryRun }) =>
      run(() => {
        const key = normalizeSenderKey(sender);
        const rules = parseProfile(profile);
        const results = testProfile(rules, samples);
        const failing = results.filter((r) => !r.pass).length;
        const passing = results.length - failing;
        const base = { sender: key, bank: rules.bank, examples: results.length, passing, results };
        if (dryRun) return { ...base, saved: false, dryRun: true, next: failing ? "Corrige las reglas según problems y vuelve a probar." : "Todos pasan: llama de nuevo sin dryRun para guardarlas." };
        const needed = minimumExamples(rules);
        if (samples.length < needed) throw new Error(`Se necesitan al menos ${needed} comprobantes de ejemplo${needed > 1 ? " (idealmente 4, de tipos distintos)" : ""} para guardar las reglas; recibí ${samples.length}.`);
        if (failing) return { ...base, saved: false, next: "No se guardó: corrige las reglas según problems y vuelve a llamar." };
        saveProfile(db, key, rules, samples.length);
        return { ...base, saved: true, next: "Reglas guardadas. Ya puedes sincronizar los correos de este remitente." };
      }),
  );

  server.registerTool(
    "eliminar_formato_banco",
    {
      description: "Borra las reglas aprendidas de un remitente (sender: dirección o dominio). Si el banco es uno incluido (BBVA Colombia), vuelve a usarse el formato incluido.",
      inputSchema: { sender: z.string().min(3).max(120) },
    },
    ({ sender }) => run(() => ({ removed: removeProfile(db, sender) })),
  );
}
