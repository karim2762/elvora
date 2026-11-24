import SectionHeader from '../../../components/ui/SectionHeader';
import Accordion from '../../../components/ui/Accordion';
import { faqs } from '../../../config/site';

export default function Faq() {
  return (
    <section className="section container container--narrow" id="faq" aria-labelledby="faq-title">
      <SectionHeader id="faq-title" eyebrow="FAQ" title="Frequently Asked Questions" />
      <Accordion items={faqs} />
    </section>
  );
}
