import { ServicePage, serviceMetadata } from "@/components/site/service-page";

export const metadata = serviceMetadata("deposito-merci");

export default function Page() {
  return <ServicePage code="deposito-merci" />;
}
