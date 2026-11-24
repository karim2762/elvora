import Navbar from './Navbar';
import Footer from './Footer';
import ScrollManager from './ScrollManager';

export default function Layout({ children }) {
  return (<><ScrollManager /><Navbar /><main id="main" tabIndex={-1}>{children}</main><Footer /></>);
}
