import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import { routes } from "wasp/client/router";
import { Loader2 } from "lucide-react";

import ExamplesCarousel from "./components/ExamplesCarousel";
import FAQ from "./components/FAQ";
import FeaturesGrid from "./components/FeaturesGrid";
import Footer from "./components/Footer";
import Hero from "./components/Hero";
import Testimonials from "./components/Testimonials";
import {
  examples,
  faqs,
  features,
  footerNavigation,
  testimonials,
} from "./contentSections";
import AIReady from "./ExampleHighlightedFeature";

export default function LandingPage() {
  const { data: user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="bg-background text-foreground flex min-h-[50vh] items-center justify-center">
        <Loader2 className="text-muted-foreground h-10 w-10 animate-spin" />
      </div>
    );
  }

  if (user) {
    return <Navigate to={routes.DocumentsRoute.to} replace />;
  }

  return (
    <div className="bg-background text-foreground">
      <main className="isolate">
        <Hero />
        <ExamplesCarousel examples={examples} />
        <AIReady />
        <FeaturesGrid features={features} />
        <Testimonials testimonials={testimonials} />
        <FAQ faqs={faqs} />
      </main>
      <Footer footerNavigation={footerNavigation} />
    </div>
  );
}
