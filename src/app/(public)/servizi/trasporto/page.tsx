import { ServicePage, serviceMetadata } from "@/components/site/service-page";

export const metadata = serviceMetadata("trasporto");

export default function Page() {
  return <ServicePage code="trasporto" />;
}
