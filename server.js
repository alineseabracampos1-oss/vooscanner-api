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

// Cache dinâmico para aeroportos não mapeados
const dynamicCache = {};

async function getAirportId(code) {
  // Cache dinâmico
  if (dynamicCache[code]) return dynamicCache[code];
  // Usa auto-complete que retorna resultado filtrado corretamente
  const url = `https://${HOST}/flights/auto-complete?query=${encodeURIComponent(code)}&locale=pt-BR`;
  const res = await fetch(url, { headers: hdr() });
  if (!res.ok) throw new Error(`Airport lookup ${res.status}`);
  const data = await res.json();
  const list = data.data || [];
  // Busca match exato pelo código IATA
  const match = list.find(a =>
    a.skyId === code ||
    a.iata  === code ||
    a.presentation?.skyId === code
  ) || list[0];
  if (!match) throw new Error(`Aeroporto ${code} não encontrado`);
  const result = {
    skyId:    match.skyId || match.presentation?.skyId || code,
    entityId: match.entityId || match.id,
  };
  console.log(`Airport ${code}:`, result);
  dynamicCache[code] = result;
  return result;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "VooScanner API online ✈", api: HOST, cached: Object.keys(dynamicCache) });
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

// Debug — mostra resposta bruta da busca de voos
app.get("/api/debug-flight", async (req, res) => {
  const { fromId, toId, date } = req.query;
  try {
    const url = `https://${HOST}/flights/search-one-way?fromEntityId=${fromId}&toEntityId=${toId}&departDate=${date||"2026-07-10"}&adults=1&currency=BRL`;
    const r = await fetch(url, { headers: hdr() });
    const data = await r.json();
    res.json({ 
      status: r.status, 
      itineraries_count: data?.data?.itineraries?.length || 0,
      context: data?.data?.context,
      first: data?.data?.itineraries?.[0] || null,
      raw_keys: Object.keys(data || {})
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug — busca aeroporto via auto-complete e mostra IDs
app.get("/api/debug-ap", async (req, res) => {
  const { q } = req.query;
  try {
    const url = `https://${HOST}/flights/auto-complete?query=${encodeURIComponent(q||"Fortaleza")}&locale=pt-BR`;
    const r = await fetch(url, { headers: hdr() });
    const data = await r.json();
    const items = (data.data||[]).slice(0,5).map(a=>({
      skyId: a.skyId, 
      entityId: a.entityId,
      id: a.id,
      name: a.presentation?.title || a.name || a.iata
    }));
    res.json({ status: r.status, items });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner na porta ${PORT} — ${HOST}`));
