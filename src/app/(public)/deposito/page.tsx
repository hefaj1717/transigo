import { ServicePage, serviceMetadata } from "@/components/site/service-page";

export const metadata = serviceMetadata("deposito");

export default function Page() {
  return <ServicePage code="deposito" />;
}
