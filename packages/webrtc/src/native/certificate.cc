#include "certificate.hpp"

#include <chrono>
#include <cmath>
#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

#include <openssl/bio.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>

namespace webrtc_node {
namespace {

std::string OpenSslErrorString() {
	unsigned long error = ERR_get_error();
	if (!error)
		return "unknown OpenSSL error";
	char buffer[256];
	ERR_error_string_n(error, buffer, sizeof(buffer));
	return buffer;
}

void CheckOpenSsl(int result, const char *message) {
	if (result != 1)
		throw std::runtime_error(std::string(message) + ": " + OpenSslErrorString());
}

void CheckOpenSslPositive(int result, const char *message) {
	if (result <= 0)
		throw std::runtime_error(std::string(message) + ": " + OpenSslErrorString());
}

using BioPtr = std::unique_ptr<BIO, decltype(&BIO_free)>;
using EvpPkeyPtr = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using EvpPkeyCtxPtr = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;
using X509Ptr = std::unique_ptr<X509, decltype(&X509_free)>;

std::string BioToString(BIO *bio) {
	BUF_MEM *memory = nullptr;
	BIO_get_mem_ptr(bio, &memory);
	if (!memory || !memory->data)
		return {};
	return std::string(memory->data, memory->length);
}

EvpPkeyPtr GenerateEcKey() {
	EvpPkeyCtxPtr parameterContext(EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr),
	                               EVP_PKEY_CTX_free);
	if (!parameterContext)
		throw std::runtime_error("Failed to allocate EC parameter context");
	CheckOpenSsl(EVP_PKEY_paramgen_init(parameterContext.get()), "Failed to initialize EC parameters");
	CheckOpenSsl(EVP_PKEY_CTX_set_ec_paramgen_curve_nid(parameterContext.get(),
	                                                    NID_X9_62_prime256v1),
	             "Failed to set EC curve");

	EVP_PKEY *parametersRaw = nullptr;
	CheckOpenSsl(EVP_PKEY_paramgen(parameterContext.get(), &parametersRaw),
	             "Failed to generate EC parameters");
	EvpPkeyPtr parameters(parametersRaw, EVP_PKEY_free);

	EvpPkeyCtxPtr keyContext(EVP_PKEY_CTX_new(parameters.get(), nullptr), EVP_PKEY_CTX_free);
	if (!keyContext)
		throw std::runtime_error("Failed to allocate EC key context");
	CheckOpenSsl(EVP_PKEY_keygen_init(keyContext.get()), "Failed to initialize EC key generation");

	EVP_PKEY *keyRaw = nullptr;
	CheckOpenSsl(EVP_PKEY_keygen(keyContext.get(), &keyRaw), "Failed to generate EC key");
	return EvpPkeyPtr(keyRaw, EVP_PKEY_free);
}

EvpPkeyPtr GenerateRsaKey(uint32_t modulusLength) {
	EvpPkeyCtxPtr keyContext(EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr), EVP_PKEY_CTX_free);
	if (!keyContext)
		throw std::runtime_error("Failed to allocate RSA key context");
	CheckOpenSsl(EVP_PKEY_keygen_init(keyContext.get()), "Failed to initialize RSA key generation");
	CheckOpenSsl(EVP_PKEY_CTX_set_rsa_keygen_bits(keyContext.get(), static_cast<int>(modulusLength)),
	             "Failed to set RSA modulus length");

	EVP_PKEY *keyRaw = nullptr;
	CheckOpenSsl(EVP_PKEY_keygen(keyContext.get(), &keyRaw), "Failed to generate RSA key");
	return EvpPkeyPtr(keyRaw, EVP_PKEY_free);
}

long ExpirationSecondsFromMilliseconds(double expiresMs) {
	if (expiresMs <= 0)
		return 0;
	double seconds = std::ceil(expiresMs / 1000.0);
	constexpr double maxLongSeconds = 2147483647.0;
	if (seconds > maxLongSeconds)
		seconds = maxLongSeconds;
	return static_cast<long>(seconds);
}

std::string FingerprintForCertificate(X509 *certificate) {
	unsigned char digest[EVP_MAX_MD_SIZE];
	unsigned int digestLength = 0;
	CheckOpenSsl(X509_digest(certificate, EVP_sha256(), digest, &digestLength),
	             "Failed to compute certificate fingerprint");

	std::ostringstream output;
	output << std::hex << std::nouppercase << std::setfill('0');
	for (unsigned int i = 0; i < digestLength; ++i) {
		if (i)
			output << ':';
		output << std::setw(2) << static_cast<unsigned int>(digest[i]);
	}
	return output.str();
}

double CertificateExpirationMilliseconds(X509 *certificate) {
	int days = 0;
	int seconds = 0;
	if (ASN1_TIME_diff(&days, &seconds, nullptr, X509_get0_notAfter(certificate)) != 1)
		throw std::runtime_error("Failed to read certificate expiration");

	const auto now = std::chrono::system_clock::now().time_since_epoch();
	const auto remaining = std::chrono::hours(days * 24LL) + std::chrono::seconds(seconds);
	return static_cast<double>(
	    std::chrono::duration_cast<std::chrono::milliseconds>(now + remaining).count());
}

X509Ptr ReadCertificate(const std::string &certificatePem) {
	if (certificatePem.size() > static_cast<size_t>(std::numeric_limits<int>::max()))
		throw std::invalid_argument("Certificate PEM is too large");
	BioPtr bio(BIO_new_mem_buf(certificatePem.data(), static_cast<int>(certificatePem.size())),
	           BIO_free);
	if (!bio)
		throw std::runtime_error("Failed to allocate certificate PEM BIO");

	ERR_clear_error();
	X509Ptr certificate(PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr), X509_free);
	if (!certificate)
		throw std::runtime_error("Invalid certificate PEM: " + OpenSslErrorString());
	return certificate;
}

EvpPkeyPtr ReadPrivateKey(const std::string &keyPem) {
	if (keyPem.size() > static_cast<size_t>(std::numeric_limits<int>::max()))
		throw std::invalid_argument("Private key PEM is too large");
	BioPtr bio(BIO_new_mem_buf(keyPem.data(), static_cast<int>(keyPem.size())), BIO_free);
	if (!bio)
		throw std::runtime_error("Failed to allocate private key PEM BIO");

	ERR_clear_error();
	EvpPkeyPtr key(PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr), EVP_PKEY_free);
	if (!key)
		throw std::runtime_error("Invalid private key PEM: " + OpenSslErrorString());
	return key;
}

} // namespace

CertificateMaterial GenerateCertificateMaterial(const std::string &algorithm, uint32_t modulusLength,
                                                double expiresMs) {
	EvpPkeyPtr key = algorithm == "RSASSA-PKCS1-v1_5" ? GenerateRsaKey(modulusLength)
	                                                   : GenerateEcKey();
	X509Ptr certificate(X509_new(), X509_free);
	if (!certificate)
		throw std::runtime_error("Failed to allocate X509 certificate");

	CheckOpenSsl(X509_set_version(certificate.get(), 2), "Failed to set certificate version");
	auto serial = std::chrono::system_clock::now().time_since_epoch().count();
	ASN1_INTEGER_set(X509_get_serialNumber(certificate.get()), static_cast<long>(serial & 0x7fffffff));
	X509_gmtime_adj(X509_get_notBefore(certificate.get()), -3600);
	X509_gmtime_adj(X509_get_notAfter(certificate.get()),
	                ExpirationSecondsFromMilliseconds(expiresMs));
	CheckOpenSsl(X509_set_pubkey(certificate.get(), key.get()), "Failed to set certificate public key");

	X509_NAME *name = X509_get_subject_name(certificate.get());
	CheckOpenSsl(X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
	                                        reinterpret_cast<const unsigned char *>("webrtc-node"),
	                                        -1, -1, 0),
	             "Failed to set certificate subject");
	CheckOpenSsl(X509_set_issuer_name(certificate.get(), name), "Failed to set certificate issuer");
	CheckOpenSslPositive(X509_sign(certificate.get(), key.get(), EVP_sha256()),
	                     "Failed to sign certificate");

	BioPtr certificateBio(BIO_new(BIO_s_mem()), BIO_free);
	BioPtr keyBio(BIO_new(BIO_s_mem()), BIO_free);
	if (!certificateBio || !keyBio)
		throw std::runtime_error("Failed to allocate PEM BIO");
	CheckOpenSsl(PEM_write_bio_X509(certificateBio.get(), certificate.get()),
	             "Failed to encode certificate PEM");
	CheckOpenSsl(PEM_write_bio_PrivateKey(keyBio.get(), key.get(), nullptr, nullptr, 0, nullptr,
	                                      nullptr),
	             "Failed to encode private key PEM");

	return {BioToString(certificateBio.get()), BioToString(keyBio.get()),
	        FingerprintForCertificate(certificate.get()),
	        CertificateExpirationMilliseconds(certificate.get())};
}

CertificateMaterial ImportCertificateMaterial(const std::string &certificatePem,
                                              const std::string &keyPem) {
	auto certificate = ReadCertificate(certificatePem);
	auto key = ReadPrivateKey(keyPem);

	ERR_clear_error();
	if (X509_check_private_key(certificate.get(), key.get()) != 1)
		throw std::runtime_error("Certificate and private key do not match");

	return {certificatePem, keyPem, FingerprintForCertificate(certificate.get()),
	        CertificateExpirationMilliseconds(certificate.get())};
}

} // namespace webrtc_node
