import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import QrModal from '../components/QrModal.jsx';

// Reached either from the Documents list or by scanning a QR code printed
// on a physical folder/appliance — access control is still enforced
// server-side via requirePropertyAccess on GET /documents/:id.
export default function DocumentDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    api.documents
      .get(id)
      .then(setDoc)
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <p className="text-red-600 text-sm">{error}</p>;
  if (!doc) return <p>{t('common.loading')}</p>;

  return (
    <div className="max-w-md">
      <button onClick={() => navigate('/documents')} className="text-sm text-brand-700 hover:underline mb-3">
        ← {t('nav.documents')}
      </button>
      <div className="bg-white rounded-lg shadow p-4">
        <h1 className="font-semibold text-lg text-brand-700">{doc.title}</h1>
        <p className="text-sm text-gray-500 mb-3">
          {doc.category} · {doc.document_date || '—'} {doc.expiry_date ? `· exp ${doc.expiry_date}` : ''}
        </p>
        {doc.tags && <p className="text-xs text-gray-500 mb-3">🏷 {doc.tags}</p>}
        {doc.notes && <p className="text-sm mb-3 whitespace-pre-wrap">{doc.notes}</p>}
        <div className="flex gap-3 text-sm">
          <a href={api.documents.downloadUrl(doc.id)} className="px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700">
            {t('documents.download')}
          </a>
          <button onClick={() => setShowQr(true)} className="px-3 py-1.5 rounded border hover:bg-gray-50">
            {t('documents.qr')}
          </button>
        </div>
      </div>

      {showQr && (
        <QrModal
          title={t('qr.document_title')}
          subtitle={doc.title}
          value={`${window.location.origin}/documents/${doc.id}`}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}
