import { usePageMeta } from '../../hooks/usePageMeta';
import Hero from './sections/Hero';
import Stats from './sections/Stats';
import About from './sections/About';
import Services from './sections/Services';
import Domains from './sections/Domains';
import WhyChoose from './sections/WhyChoose';
import HowItWorks from './sections/HowItWorks';
import Durations from './sections/Durations';
import Msme from './sections/Msme';
import Testimonials from './sections/Testimonials';
import Faq from './sections/Faq';
import Cta from './sections/Cta';

export default function Home() {
  usePageMeta('', 'ELVORA offers practical CSE internships for students: Python, Java, web, AI, ML, data science, cybersecurity, cloud and UI/UX.');
  return (<><Hero /><Stats /><About /><Services /><Domains /><WhyChoose /><HowItWorks /><Durations /><Msme /><Testimonials /><Faq /><Cta /></>);
}
