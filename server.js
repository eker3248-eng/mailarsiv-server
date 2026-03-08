const express = require('express');
const Imap = require('imap');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS;
const PORT           = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MailArsiv API', version: '1.0' });
});

app.get('/api/account', (req, res) => {
  res.json({
    gmail: GMAIL_USER
      ? { connected: true, email: GMAIL_USER }
      : { connected: false }
  });
});

app.get('/api/mails', (req, res) => {
  if (!GMAIL_USER || !GMAIL_APP_PASS) {
    return res.status(500).json({ error: 'Ortam degiskenleri ayarlanmamis' });
  }

  const limit = parseInt(req.query.limit) || 30;

  const imap = new Imap({
    user: GMAIL_USER,
    password: GMAIL_APP_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  const mails = [];

  imap.once('ready', () => {
    imap.openBox('INBOX', true, (err, box) => {
      if (err) {
        imap.end();
        return res.status(500).json({ error: err.message });
      }

      const total = box.messages.total;
      if (total === 0) {
        imap.end();
        return res.json({ mails: [], account: GMAIL_USER, total: 0 });
      }

      const start = Math.max(1, total - limit + 1);

      const fetch = imap.seq.fetch(start + ':' + total, {
        bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)', 'TEXT'],
        struct: true
      });

      fetch.on('message', (msg, seqno) => {
        const mail = {
          id: 'gmail_' + seqno,
          source: 'gmail',
          seqno: seqno
        };
        let headerBuf = '';
        let bodyBuf = '';

        msg.on('body', (stream, info) => {
          let buf = '';
          stream.on('data', chunk => { buf += chunk.toString('utf8'); });
          stream.once('end', () => {
            if (info.which.indexOf('HEADER') >= 0) headerBuf = buf;
            else bodyBuf = buf;
          });
        });

        msg.once('attributes', attrs => {
          mail.uid  = attrs.uid;
          mail.read = (attrs.flags || []).indexOf('\\Seen') >= 0;
          mail.date = attrs.date ? attrs.date.toISOString() : new Date().toISOString();
          mail.hasAttachment = checkAttachment(attrs.struct);
        });

        msg.once('end', () => {
          const fromMatch    = headerBuf.match(/^From:\s*(.+)$/mi);
          const subjectMatch = headerBuf.match(/^Subject:\s*(.+)$/mi);

          let fromRaw  = fromMatch ? fromMatch[1].trim() : 'Bilinmeyen';
          let emailMatch = fromRaw.match(/<(.+?)>/);
          mail.email   = emailMatch ? emailMatch[1] : fromRaw;
          mail.from    = fromRaw.replace(/<.+?>/, '').replace(/"/g, '').trim() || mail.email;
          mail.subject = subjectMatch ? subjectMatch[1].trim() : '(Konu yok)';

          let clean  = bodyBuf.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          mail.preview = clean.slice(0, 100);
          mail.body    = clean.slice(0, 500) || '(Icerik yuklenemedi)';
          mail.size    = Math.round((headerBuf.length + bodyBuf.length) / 1024) || 1;

          mails.push(mail);
        });
      });

      fetch.once('error', err => {
        imap.end();
        res.status(500).json({ error: err.message });
      });

      fetch.once('end', () => {
        imap.end();
      });
    });
  });

  imap.once('end', () => {
    mails.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ mails: mails, account: GMAIL_USER, total: mails.length });
  });

  imap.once('error', err => {
    res.status(500).json({ error: 'IMAP hatasi: ' + err.message });
  });

  imap.connect();
});

app.delete('/api/mails/:uid', (req, res) => {
  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'Gecersiz UID' });

  const imap = new Imap({
    user: GMAIL_USER,
    password: GMAIL_APP_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, err => {
      if (err) { imap.end(); return res.status(500).json({ error: err.message }); }
      imap.addFlags(uid, '\\Deleted', err => {
        if (err) { imap.end(); return res.status(500).json({ error: err.message }); }
        imap.expunge(err => {
          imap.end();
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        });
      });
    });
  });

  imap.once('error', err => res.status(500).json({ error: err.message }));
  imap.connect();
});

function checkAttachment(struct) {
  if (!struct) return false;
  if (Array.isArray(struct)) return struct.some(s => checkAttachment(s));
  if (struct.disposition) {
    var t = (struct.disposition.type || '').toLowerCase();
    if (t === 'attachment' || t === 'inline') return true;
  }
  return false;
}

app.listen(PORT, () => {
  console.log('MailArsiv API port ' + PORT + ' uzerinde calisiyor');
  console.log('Gmail: ' + (GMAIL_USER || 'ayarlanmamis'));
});
