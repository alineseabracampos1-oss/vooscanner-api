const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;
const KEY  = process.env.RAPIDAPI_KEY;
const HOST = "flights-sky.p.rapidapi.com";

app.use(cors());
app.use(express.json());

const hdr = () => ({
  "x-rapidapi-host": HOST,
  "x-rapidapi-key":  KEY,
  "Content-Type": "application/json",
});

// Cache em memória para IDs de aeroportos
const cache = {};

async function getAirportId(code) {
  if (cache[code]) return cache[code];
  const url = `https://${HOST}/flights/airports?query=${encodeURIComponent(code)}`;
  const res = await fetch(url, { headers: hdr() });
  if (!res.ok) throw new Error(`Airport lookup ${res.status}`);
  const data = await res.json();
  const list = data.data || [];
  const match = list.find(a =>
    a.skyId === code ||
    a.iata === code  ||
    (a.presentation && a.presentation.skyId === code)
  ) || list[0];
  if (!match) throw new Error(`Aeroporto ${code} não encontrado`);
  const result = {
    skyId:    match.skyId    || match.iata || code,
    entityId: match.entityId || match.id,
    name:     match.presentation?.title || match.name || code,
  };
  cache[code] = result;
  console.log(`Airport ${code}:`, result);
  return result;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "VooScanner API online ✈", api: HOST, cached: Object.keys(cache) });
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

// Calendário de preços — encontra datas mais baratas
app.get("/api/calendar", async (req, res) => {
  const { origin, dest } = req.query;
  if (!origin || !dest) return res.status(400).json({ error: "origin e dest são obrigatórios" });
  try {
    const [oAp, dAp] = await Promise.all([
      getAirportId(origin.toUpperCase()),
      getAirportId(dest.toUpperCase()),
    ]);
    const url = `https://${HOST}/flights/price-calendar` +
      `?fromEntityId=${oAp.entityId}&toEntityId=${dAp.entityId}&currency=BRL`;
    const r = await fetch(url, { headers: hdr() });
    if (!r.ok) throw new Error(`Calendar API ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner na porta ${PORT} — ${HOST}`));
