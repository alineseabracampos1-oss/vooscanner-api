const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;
const KEY  = process.env.RAPIDAPI_KEY;
const HOST = "sky-scrapper3.p.rapidapi.com";

app.use(cors());
app.use(express.json());

const headers = () => ({ "x-rapidapi-host": HOST, "x-rapidapi-key": KEY });

// Cache de IDs de aeroportos para economizar requisições
const airportCache = {};

async function getAirportId(code) {
  if (airportCache[code]) return airportCache[code];
  const url = `https://${HOST}/api/v1/flights/searchAirport?query=${code}&locale=pt-BR`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Airport lookup failed: ${res.status}`);
  const data = await res.json();
  const airports = data.data || [];
  // Pega o primeiro resultado que bate exatamente com o código IATA
  const match = airports.find(a =>
    a.skyId === code ||
    a.presentation?.skyId === code ||
    (a.navigation?.entityId && a.navigation.relevantHotels === 0)
  ) || airports[0];
  if (!match) throw new Error(`Aeroporto ${code} não encontrado`);
  const result = {
    skyId:    match.skyId || match.presentation?.skyId || code,
    entityId: match.entityId || match.navigation?.entityId,
  };
  airportCache[code] = result;
  console.log(`Airport ${code}:`, result);
  return result;
}

// Health check
app.get("/", (req, res) => res.json({ status: "VooScanner API online ✈" }));

// Busca voos reais
app.get("/api/flights", async (req, res) => {
  const { origin, dest, date, pax = 1 } = req.query;
  if (!origin || !dest || !date) return res.status(400).json({ error: "origin, dest e date são obrigatórios" });
  if (!KEY) return res.status(500).json({ error: "RAPIDAPI_KEY não configurada" });

  try {
    console.log(`Buscando: ${origin} → ${dest} em ${date}`);

    // Busca IDs reais dos aeroportos
    const [oAp, dAp] = await Promise.all([getAirportId(origin), getAirportId(dest)]);
    console.log(`IDs: ${oAp.skyId}(${oAp.entityId}) → ${dAp.skyId}(${dAp.entityId})`);

    const url = `https://${HOST}/api/v2/flights/searchFlightsComplete` +
      `?originSkyId=${oAp.skyId}&destinationSkyId=${dAp.skyId}` +
      `&originEntityId=${oAp.entityId}&destinationEntityId=${dAp.entityId}` +
      `&date=${date}&adults=${pax}&currency=BRL&locale=pt-BR&cabinClass=economy`;

    const r = await fetch(url, { headers: headers() });
    const txt = await r.text();

    if (!r.ok) {
      console.error("RapidAPI error:", r.status, txt.slice(0, 200));
      return res.status(r.status).json({ error: `RapidAPI error ${r.status}`, detail: txt.slice(0, 200) });
    }

    const data = JSON.parse(txt);
    const itineraries = data?.data?.itineraries || [];

    if (itineraries.length === 0) {
      console.log("Sem resultados. Resposta:", JSON.stringify(data).slice(0, 300));
    }

    const flights = itineraries.slice(0, 20).map((it, i) => {
      const leg     = it.legs?.[0];
      const carrier = leg?.carriers?.marketing?.[0];
      const price   = it.price?.raw || 0;
      const stops   = leg?.stopCount || 0;
      const dep     = leg?.departure?.slice(11, 16) || "--:--";
      const arr     = leg?.arrival?.slice(11, 16)   || "--:--";
      const durMin  = leg?.durationInMinutes || 0;
      const durFmt  = durMin > 0
        ? `${Math.floor(durMin/60)}h${durMin%60 > 0 ? String(durMin%60).padStart(2,"0")+"m" : ""}`
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

    console.log(`Encontrados: ${flights.length} voos`);
    res.json({ flights, total: flights.length, source: "Skyscanner via RapidAPI" });

  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner API na porta ${PORT}`));
