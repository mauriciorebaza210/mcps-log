/**
 * Vercel Serverless Function to proxy Google Drive images
 * usage: /api/avatar?id=FILE_ID
 */
export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing file id');

  // Use lh3 format for CDN benefits, but Drive UC also works
  const url = `https://lh3.googleusercontent.com/d/${id}`;
  
  try {
    const response = await fetch(url);
    
    // Google might 429 the proxy too if we're unlucky, but it's unlikely with Vercel's IP pool
    if (!response.ok) {
      return res.status(response.status).send(`Google returned ${response.status}`);
    }

    const contentBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Set CORS headers so the frontend can fetch() this if it wants to migrate to local storage
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=43200');
    
    return res.end(Buffer.from(contentBuffer));
  } catch (error) {
    console.error('Avatar Proxy Error:', error);
    return res.status(500).send('Internal Server Error');
  }
}
