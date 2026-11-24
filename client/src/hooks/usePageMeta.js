import { useEffect } from 'react';
import { brand } from '../config/site';

// Sets <title> and meta description per page (client-side SEO basics).
export function usePageMeta(title, description = brand.description) {
  useEffect(() => {
    document.title = title ? `${title} — ${brand.name}` : `${brand.name} — ${brand.tagline}`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  }, [title, description]);
}
