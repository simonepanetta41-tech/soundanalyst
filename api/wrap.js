export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng, filters, radius = 1500 } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });

  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_PLACES_KEY not configured' });

  // Map filters to Google Places types
  const typeMap = {
    pranzo:    ['restaurant', 'trattoria'],
    birra:     ['bar'],
    vino:      ['wine_bar'],
    aperitivo: ['bar'],
    cena:      ['restaurant'],
  };

  const activeTypes = [...new Set(
    (filters || ['pranzo']).flatMap(f => typeMap[f] || ['restaurant'])
  )];

  // Build keyword for Osterie d'Italia / slow food preference
  const slowFoodKeyword = filters?.includes('pranzo') || filters?.includes('cena')
    ? 'osteria trattoria' : '';

  const results = [];

  for (const type of activeTypes.slice(0, 2)) {
    const url = new URL('https://places.googleapis.com/v1/places:searchNearby');
    const body = {
      includedTypes: [type],
      maxResultCount: 10,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius
        }
      },
      ...(slowFoodKeyword ? { textQuery: slowFoodKeyword } : {})
    };

    const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.internationalPhoneNumber,places.websiteUri,places.location,places.photos,places.types,places.editorialSummary'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (data.places) results.push(...data.places);
  }

  // Deduplicate by place id
  const seen = new Set();
  const unique = results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id); return true;
  });

  // Sort: prefer places with "osteria", "trattoria" in name (Slow Food style)
  unique.sort((a, b) => {
    const aName = a.displayName?.text?.toLowerCase() || '';
    const bName = b.displayName?.text?.toLowerCase() || '';
    const aSlowFood = /osteria|trattoria|locanda/.test(aName) ? 1 : 0;
    const bSlowFood = /osteria|trattoria|locanda/.test(bName) ? 1 : 0;
    if (aSlowFood !== bSlowFood) return bSlowFood - aSlowFood;
    return (b.rating || 0) - (a.rating || 0);
  });

  return res.status(200).json({ places: unique.slice(0, 15) });
}
