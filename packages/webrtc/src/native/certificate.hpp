#pragma once

#include <cstdint>
#include <string>

namespace webrtc_node {

struct CertificateMaterial {
	std::string certificatePem;
	std::string keyPem;
	std::string fingerprint;
	double expires = 0;
};

CertificateMaterial GenerateCertificateMaterial(const std::string &algorithm,
                                                uint32_t modulusLength, double expiresMs);
CertificateMaterial ImportCertificateMaterial(const std::string &certificatePem,
                                               const std::string &keyPem);

} // namespace webrtc_node
