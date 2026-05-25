const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "sky-scrapper3.p.rapidapi.com";

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "VooScanner API online ✈" }));

// Busca voos reais via Sky Scrapper / Skyscanner
app.get("/api/flights", async (req, res) => {
  const { origin, dest, originId, destId, date, pax = 1 } = req.query;
  if (!origin || !dest || !date) return res.status(400).json({ error: "origin, dest e date são obrigatórios" });
  if (!RAPIDAPI_KEY)             return res.status(500).json({ error: "RAPIDAPI_KEY não configurada no servidor" });

  // IDs Skyscanner pré-mapeados para os aeroportos mais usados
  const AIRPORT_IDS = {
    GRU:"95673508",CGH:"95673504",GIG:"95673441",SDU:"95673439",
    BSB:"95673364",FOR:"95673397",SSA:"95673529",REC:"95673492",
    MAO:"95673459",CWB:"95673387",POA:"95673486",BEL:"95673352",
    NAT:"95673466",VCP:"95673510",FLN:"95673399",MCZ:"95673456",
    MIA:"95673577",JFK:"95565058",LAX:"95565071",MCO:"95565067",
    ORD:"95565049",ATL:"95565041",LIS:"95565099",MAD:"95565051",
    CDG:"95565040",LHR:"95565050",FRA:"95565045",AMS:"95565036",
    FCO:"95565046",BCN:"95565038",
  };

  const oId = originId || AIRPORT_IDS[origin];
  const dId = destId   || AIRPORT_IDS[dest];
  if (!oId || !dId) return res.status(400).json({ error: `Aeroporto não mapeado: ${!oId?origin:dest}` });

  try {
    const url = `https://${RAPIDAPI_HOST}/api/v2/flights/searchFlightsComplete` +
      `?originSkyId=${origin}&destinationSkyId=${dest}` +
      `&originEntityId=${oId}&destinationEntityId=${dId}` +
      `&date=${date}&adults=${pax}&currency=BRL&locale=pt-BR&cabinClass=economy`;

    const response = await fetch(url, {
      headers: {
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key":  RAPIDAPI_KEY,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `RapidAPI error ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const itineraries = data?.data?.itineraries || [];

    const flights = itineraries.slice(0, 20).map((it, i) => {
      const leg     = it.legs?.[0];
      const carrier = leg?.carriers?.marketing?.[0];
      const price   = it.price?.raw || 0;
      const stops   = leg?.stopCount || 0;
      const dep     = leg?.departure?.slice(11,16) || "--:--";
      const arr     = leg?.arrival?.slice(11,16)   || "--:--";
      const durMin  = leg?.durationInMinutes || 0;
      const durFmt  = durMin > 0 ? `${Math.floor(durMin/60)}h${durMin%60>0?String(durMin%60).padStart(2,"0")+"m":""}` : "";
      return {
        id:          it.id || `f${i}`,
        price:       Math.round(price),
        priceFmt:    `R$ ${Math.round(price).toLocaleString("pt-BR")}`,
        stops,
        airline:     carrier?.alternateId || "",
        airlineName: carrier?.name        || "",
        airlineLogo: carrier?.logoUrl     || "",
        dep, arr, durFmt,
        date, origin, dest,
        verified:    true,
        buyUrl:      it.deeplink || `https://www.skyscanner.com.br/transporte/passagens-aereas/${origin.toLowerCase()}/${dest.toLowerCase()}/`,
      };
    }).filter(f => f.price > 0).sort((a, b) => a.price - b.price);

    res.json({ flights, total: flights.length, source: "Skyscanner via RapidAPI" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✈ VooScanner API rodando na porta ${PORT}`));
