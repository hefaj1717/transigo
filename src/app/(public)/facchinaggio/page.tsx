import { ServicePage, serviceMetadata } from "@/components/site/service-page";

export const metadata = serviceMetadata("facchinaggio");

export default function Page() {
  return <ServicePage code="facchinaggio" />;
}
