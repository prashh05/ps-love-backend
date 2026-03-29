require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

let db, bucket;

async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db     = client.db(process.env.MONGODB_DB || 'ps-love');
  bucket = new GridFSBucket(db, { bucketName: 'photos' });
  console.log('💕 Connected to MongoDB');
}

app.get('/', (req, res) => res.json({ status: '💕 P & S backend is live!' }));

// GET all photos — sorted by slot ascending
app.get('/photos', async (req, res) => {
  try {
    const rows = await db.collection('gallery').find({}).sort({ slot: 1 }).toArray();
    res.json(rows.map(r => ({ slot: r.slot, url: r.url })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPLOAD — slot can be any non-negative integer now (unlimited)
app.post('/photos/:slot', upload.single('photo'), async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (isNaN(slot) || slot < 0)
    return res.status(400).json({ error: 'Invalid slot' });

  if (!req.file)
    return res.status(400).json({ error: 'No file received' });

  try {
    const ext      = req.file.mimetype.split('/')[1] || 'jpg';
    const fileName = `slot-${slot}-${Date.now()}.${ext}`;

    // Delete existing file for this slot
    const existingFiles = await bucket.find({ filename: { $regex: `^slot-${slot}-` } }).toArray();
    for (const f of existingFiles) await bucket.delete(f._id);

    // Upload new file
    const uploadStream = bucket.openUploadStream(fileName, { contentType: req.file.mimetype });
    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
      uploadStream.end(req.file.buffer);
    });

    const fileId    = uploadStream.id.toString();
    const publicUrl = `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}/photos/file/${fileId}`;

    await db.collection('gallery').updateOne(
      { slot },
      { $set: { slot, url: publicUrl, fileId } },
      { upsert: true }
    );

    res.json({ slot, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SERVE photo file
app.get('/photos/file/:id', async (req, res) => {
  try {
    const fileId = new ObjectId(req.params.id);
    const files  = await bucket.find({ _id: fileId }).toArray();
    if (!files.length) return res.status(404).json({ error: 'File not found' });
    res.set('Content-Type', files[0].contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000');
    bucket.openDownloadStream(fileId).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a photo
app.delete('/photos/:slot', async (req, res) => {
  const slot = parseInt(req.params.slot);
  try {
    const row = await db.collection('gallery').findOne({ slot });
    if (row?.fileId) {
      try { await bucket.delete(new ObjectId(row.fileId)); } catch (_) {}
    }
    await db.collection('gallery').deleteOne({ slot });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`💕 Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
