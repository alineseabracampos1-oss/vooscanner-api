const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;
const KEY  = process.env.RAPIDAPI_KEY;
const HOST = "sky-scrapper3.p.rapidapi.com";
const CACHE_FILE = path.join("/tmp", "airports.json");

app.use(cors());
app.use(express.json());

const hdr = () => ({ "x-rapidapi-host": HOST, "x-rapidapi-key": KEY });

// Carrega cache do disco
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch(e) { return {}; }
}
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch(e) {}
}

let airportCache = loadCache();
console.log("Cache carregado:", Object.keys(airportCache).join(", ") || "vazio");

async function getAirportId(code) {
  if (airportCache[code]) {
    console.log(`Cache hit: ${code} → ${airportCache[code].entityId}`);
    return airportCache[code];
  }
  console.log(`Buscando ID para: ${code}`);
  const url = `https://${HOST}/api/v1/flights/searchAirport?query=${code}&locale=pt-BR`;
  const res = await fetch(url, { headers: hdr() });
  if (!res.ok) throw new Error(`Airport lookup failed: ${res.status}`);
  const data = await res.json();
  const list = data.data || [];
  // Procura match exato pelo código IATA
  const match = list.find(a => a.skyId === code || a.presentation?.skyId === code) || list[0];
  if (!match) throw new Error(`Aeroporto ${code} não encontrado. Resultados: ${JSON.stringify(list.slice(0,2))}`);
  const result = {
    skyId:    match.skyId || code,
    entityId: match.entityId,
    name:     match.presentation?.title || code,
  };
  console.log(`Encontrado ${code}:`, result);
  airportCache[code] = result;
  saveCache(airportCache);
  return result;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "VooScanner API online ✈", cached_airports: Object.keys(airportCache) });
});

// Pré-carrega IDs de todos os aeroportos de uma vez (economiza créditos nas buscas)
app.get("/api/preload", async (req, res) => {
  const codes = ["GRU","CGH","GIG","BSB","FOR","SSA","REC","MAO","CWB","POA","BEL","NAT","FLN","MIA","JFK","LIS","MAD","CDG","LHR","FRA"];
  const results = {};
  const errors  = [];
  for (const code of codes) {
    if (airportCache[code]) { results[code] = airportCache[code]; continue; }
    try {
      results[code] = await getAirportId(code);
      await new Promise(r => setTimeout(r, 300)); // pausa entre requests
    } catch(e) {
      errors.push(`${code}: ${e.message}`);
    }
  }
  res.json({ loaded: Object.keys(results).length, errors, results });
});

// Busca um aeroporto (para debug)
app.get("/api/airport", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code obrigatório" });
  try {
    const r = await getAirportId(code.toUpperCase());
    res.json(r);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Busca voos reais
app.get("/api/flights", async (req, res) => {
  const { origin, dest, date, pax = 1 } = req.query;
  if (!origin || !dest || !date) return res.status(400).json({ error: "origin, dest e date são obrigatórios" });
  if (!KEY) return res.status(500).json({ error: "RAPIDAPI_KEY não configurada" });

  try {
    const [oAp, dAp] = await Promise.all([
      getAirportId(origin.toUpperCase()),
      getAirportId(dest.toUpperCase()),
    ]);
    console.log(`Busca: ${oAp.skyId}(${oAp.entityId}) → ${dAp.skyId}(${dAp.entityId}) em ${date}`);

    const url = `https://${HOST}/api/v2/flights/searchFlightsComplete` +
      `?originSkyId=${oAp.skyId}&destinationSkyId=${dAp.skyId}` +
      `&originEntityId=${oAp.entityId}&destinationEntityId=${dAp.entityId}` +
      `&date=${date}&adults=${pax}&currency=BRL&locale=pt-BR&cabinClass=economy`;

    const r = await fetch(url, { headers: hdr() });
    const txt = await r.text();
    if (!r.ok) {
      console.error(`RapidAPI ${r.status}:`, txt.slice(0, 300));
      return res.status(r.status).json({ error: `RapidAPI error ${r.status}`, detail: txt.slice(0, 300) });
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
      const durFmt  = durMin > 0 ? `${Math.floor(durMin/60)}h${durMin%60>0?String(durMin%60).padStart(2,"0")+"m":""}` : "";
      return {
        id: it.id || `f${i}`,
        price: Math.round(price),
        priceFmt: `R$ ${Math.round(price).toLocaleString("pt-BR")}`,
        stops, dep, arr, durFmt,
        airline:     carrier?.alternateId || "",
        airlineName: carrier?.name        || "",
        airlineLogo: carrier?.logoUrl     || "",
        date, origin, dest,
        verified: true,
        buyUrl: it.deeplink || `https://www.skyscanner.com.br/transporte/passagens-aereas/${origin.toLowerCase()}/${dest.toLowerCase()}/`,
      };
    }).filter(f => f.price > 0).sort((a, b) => a.price - b.price);

    res.json({ flights, total: flights.length, source: "Skyscanner via RapidAPI" });
  } catch(err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner API na porta ${PORT}`));
