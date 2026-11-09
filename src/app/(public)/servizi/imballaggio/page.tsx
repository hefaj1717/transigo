import { ServicePage, serviceMetadata } from "@/components/site/service-page";

export const metadata = serviceMetadata("imballaggio");

export default function Page() {
  return <ServicePage code="imballaggio" />;
}
