const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;
const KEY  = process.env.RAPIDAPI_KEY;
const HOST = "flights-sky.p.rapidapi.com";

app.use(cors());
app.use(express.json());
// Serve o frontend estático da pasta public/
app.use(express.static(path.join(__dirname, "public")));

const hdr = () => ({
  "x-rapidapi-host": HOST,
  "x-rapidapi-key":  KEY,
  "Content-Type": "application/json",
});

// IDs de entidade do Skyscanner — pré-carregados, sem usar a API
// Fonte: Skyscanner entity IDs (sistema interno do Flights Scraper Sky)
const AIRPORT_MAP = {
  // Brasil
  GRU: { skyId:"GRU", entityId:"27539729" },
  CGH: { skyId:"CGH", entityId:"27539728" },
  GIG: { skyId:"GIG", entityId:"27536654" },
  SDU: { skyId:"SDU", entityId:"27536651" },
  BSB: { skyId:"BSB", entityId:"27540004" },
  FOR: { skyId:"FOR", entityId:"27540167" },
  SSA: { skyId:"SSA", entityId:"27540168" },
  REC: { skyId:"REC", entityId:"27539969" },
  MAO: { skyId:"MAO", entityId:"27540030" },
  CWB: { skyId:"CWB", entityId:"27539747" },
  POA: { skyId:"POA", entityId:"27539958" },
  BEL: { skyId:"BEL", entityId:"27539762" },
  NAT: { skyId:"NAT", entityId:"27539928" },
  VCP: { skyId:"VCP", entityId:"27539510" },
  FLN: { skyId:"FLN", entityId:"27539796" },
  MCZ: { skyId:"MCZ", entityId:"27539867" },
  SLZ: { skyId:"SLZ", entityId:"27540128" },
  THE: { skyId:"THE", entityId:"27540179" },
  // EUA
  MIA: { skyId:"MIA", entityId:"27537542" },
  JFK: { skyId:"JFK", entityId:"27537541" },
  LAX: { skyId:"LAX", entityId:"27537545" },
  MCO: { skyId:"MCO", entityId:"27537543" },
  ORD: { skyId:"ORD", entityId:"27537539" },
  ATL: { skyId:"ATL", entityId:"27537533" },
  EWR: { skyId:"EWR", entityId:"27537540" },
  // Europa
  LIS: { skyId:"LIS", entityId:"27544008" },
  MAD: { skyId:"MAD", entityId:"27543993" },
  CDG: { skyId:"CDG", entityId:"27539733" },
  LHR: { skyId:"LHR", entityId:"27544008" },
  FRA: { skyId:"FRA", entityId:"27543780" },
  AMS: { skyId:"AMS", entityId:"27544066" },
  FCO: { skyId:"FCO", entityId:"27543826" },
  BCN: { skyId:"BCN", entityId:"27543769" },
};

// Cache dinâmico para aeroportos não mapeados
const dynamicCache = {};

async function getAirportId(code) {
  // Usa mapa pré-carregado (zero requisições de API)
  if (AIRPORT_MAP[code]) return AIRPORT_MAP[code];
  // Cache dinâmico
  if (dynamicCache[code]) return dynamicCache[code];
  // Fallback: busca dinâmica (gasta 1 crédito)
  console.log(`Buscando ID dinâmico para: ${code}`);
  const url = `https://${HOST}/flights/airports?query=${encodeURIComponent(code)}`;
  const res = await fetch(url, { headers: hdr() });
  if (!res.ok) throw new Error(`Airport lookup ${res.status} — aeroporto ${code} não encontrado no mapa`);
  const data = await res.json();
  const list = data.data || [];
  const match = list.find(a => a.skyId === code || a.iata === code) || list[0];
  if (!match) throw new Error(`Aeroporto ${code} não encontrado`);
  const result = { skyId: match.skyId || code, entityId: match.entityId };
  dynamicCache[code] = result;
  return result;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "VooScanner API online ✈", api: HOST, airports: Object.keys(AIRPORT_MAP).length });
});

// Busca voos reais — flights/search-one-way
app.get("/api/flights", async (req, res) => {
  const { origin, dest, date, pax = 1 } = req.query;
  if (!origin || !dest || !date) return res.status(400).json({ error: "origin, dest e date são obrigatórios" });
  if (!KEY) return res.status(500).json({ error: "RAPIDAPI_KEY não configurada" });

  try {
    // Busca IDs dos aeroportos
    const [oAp, dAp] = await Promise.all([
      getAirportId(origin.toUpperCase()),
      getAirportId(dest.toUpperCase()),
    ]);
    console.log(`Buscando ${oAp.skyId}(${oAp.entityId}) → ${dAp.skyId}(${dAp.entityId}) em ${date}`);

    const url = `https://${HOST}/flights/search-one-way` +
      `?fromEntityId=${oAp.entityId}&toEntityId=${dAp.entityId}` +
      `&departDate=${date}&adults=${pax}&currency=BRL&locale=pt-BR&cabinClass=economy`;

    const r = await fetch(url, { headers: hdr() });
    const txt = await r.text();
    if (!r.ok) {
      console.error(`API ${r.status}:`, txt.slice(0, 300));
      return res.status(r.status).json({ error: `API error ${r.status}`, detail: txt.slice(0, 300) });
    }

    const data = JSON.parse(txt);
    const itineraries = data?.data?.itineraries || [];
    console.log(`Resultado: ${itineraries.length} itinerários`);

    const flights = itineraries.slice(0, 20).map((it, i) => {
      const leg     = it.legs?.[0];
      const carrier = leg?.carriers?.marketing?.[0];
      const price   = it.price?.raw || 0;
      const stops   = leg?.stopCount || 0;
      const dep     = leg?.departure?.slice(11, 16) || "--:--";
      const arr     = leg?.arrival?.slice(11, 16)   || "--:--";
      const durMin  = leg?.durationInMinutes || 0;
      const durFmt  = durMin > 0
        ? `${Math.floor(durMin/60)}h${durMin % 60 > 0 ? String(durMin % 60).padStart(2, "0") + "m" : ""}`
        : "";
      return {
        id:          it.id || `f${i}`,
        price:       Math.round(price),
        priceFmt:    `R$ ${Math.round(price).toLocaleString("pt-BR")}`,
        stops, dep, arr, durFmt,
        airline:     carrier?.alternateId || "",
        airlineName: carrier?.name        || "",
        airlineLogo: carrier?.logoUrl     || "",
        date, origin, dest,
        verified:    true,
        buyUrl:      it.deeplink ||
          `https://www.skyscanner.com.br/transporte/passagens-aereas/${origin.toLowerCase()}/${dest.toLowerCase()}/`,
      };
    }).filter(f => f.price > 0).sort((a, b) => a.price - b.price);

    res.json({ flights, total: flights.length, source: "Skyscanner via Flights Scraper Sky" });
  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug — descobre o entityId correto de um aeroporto
app.get("/api/debug-airport", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code obrigatório" });
  try {
    const url = `https://${HOST}/flights/airports?query=${encodeURIComponent(code)}`;
    const r = await fetch(url, { headers: hdr() });
    const txt = await r.text();
    res.json({ status: r.status, raw: JSON.parse(txt) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug — testa a busca de voos com entityIds específicos
app.get("/api/debug-flight", async (req, res) => {
  const { fromId, toId, date } = req.query;
  try {
    const url = `https://${HOST}/flights/search-one-way?fromEntityId=${fromId}&toEntityId=${toId}&departDate=${date||"2026-07-10"}&adults=1&currency=BRL`;
    const r = await fetch(url, { headers: hdr() });
    const txt = await r.text();
    const data = JSON.parse(txt);
    res.json({ status: r.status, itineraries: data?.data?.itineraries?.length||0, raw_sample: data?.data?.itineraries?.[0] || data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner na porta ${PORT} — ${HOST}`));
