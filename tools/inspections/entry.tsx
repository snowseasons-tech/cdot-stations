// Mounts the inspection portal (portal.tsx, copied from the owner's download) into inspections.html.
import { createRoot } from 'react-dom/client';
import App from './portal';

createRoot(document.getElementById('root')!).render(<App />);
